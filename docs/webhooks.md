# Outbound webhooks

Admins send booking events to other systems (n8n, a partner CRM) from **Admin > Webhooks** (`/admin/webhooks`). Each delivery is a signed HTTPS `POST` with a JSON body.

## Events

| Event | When |
|---|---|
| `booking.created` | A booking is made on any page (public page, REST API, MCP). |
| `booking.rescheduled` | A booking is moved. The payload is the new booking; `rescheduledFromId` is the old one. |
| `booking.cancelled` | A booking is cancelled by the invitee, a host, an Outlook conflict or the system. |
| `booking.reassigned` | A host is taken off a booking (round-robin reassignment or queue removal). Sent once per previous host. |
| `webhook.test` | Sent by **Send test** on the admin page. |

An endpoint subscribes to one or more events and can be limited to one partner's (team's) booking pages. Imported Calendly bookings never produce events.

## Request

```
POST <endpoint URL>
Content-Type: application/json
User-Agent: BTC-Scheduler-Webhooks/1.0
BTC-Webhook-Id: <delivery id>        (the same on retries; use it to ignore duplicates)
BTC-Webhook-Event: booking.created
BTC-Signature: t=1700000000,v1=5f0c...
```

```json
{
  "id": "<event id>",
  "type": "booking.created",
  "createdAt": "2026-10-23T15:00:00.000Z",
  "data": {
    "booking": {
      "id": "…", "status": "confirmed", "createdVia": "public", "language": "en",
      "start": "2026-10-28T15:00:00.000Z", "end": "2026-10-28T15:30:00.000Z", "createdAt": "…",
      "rescheduledFromId": null,
      "eventType": { "id": "…", "name": "Financing Intro Call", "slug": "intro" },
      "team": { "id": "…", "name": "Klendify", "slug": "klendify", "partnerName": "Klendify" },
      "invitee": { "name": "…", "email": "…", "phone": "…", "timezone": "America/New_York" },
      "location": { "type": "teams", "detail": null, "joinUrl": "https://teams.microsoft.com/…" },
      "hosts": [{ "name": "…", "email": "…", "role": "primary", "active": true }],
      "answers": [{ "key": "company", "label": "Company", "value": "…" }],
      "cancellation": null
    }
  }
}
```

The payload never contains manage links, Salesforce ids, routing weights or internal flags. `team` is null for individual pages.

## Verifying the signature

`BTC-Signature` is `t=<unix seconds>,v1=<hex>`, where `<hex>` is HMAC-SHA256 of `<t>.<raw request body>` keyed by the endpoint's signing secret (`whsec_…`).

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

The secret is shown once, when the endpoint is added or its secret is rotated. Rotating replaces it immediately.

## Delivery and retries

- Delivery runs through the jobs outbox, usually within a minute of the change.
- A `2xx` response is a success. Respond quickly; the request times out after 10 seconds. Redirects are not followed.
- `408`, `409`, `425`, `429` and `5xx` responses, timeouts and connection errors are retried with exponential backoff, up to 8 attempts. `429` with `Retry-After` is honored, up to one hour.
- Any other `4xx` stops retrying.
- Only public HTTPS destinations on port 443 are allowed. Host names that resolve to private, loopback, link-local or reserved addresses are refused at every attempt.
- Disabling an endpoint stops its pending deliveries.
- The admin page shows each endpoint's last status and consecutive failures, and the last 50 deliveries. Delivery records are deleted after 30 days.

## Data model

- `app.webhook_endpoints`: URL, events, optional team, encrypted secret (never readable through `app_user`), enabled flag, last delivery status.
- `app.webhook_deliveries`: one row per endpoint and event, with the payload sent, status, attempts and last response.
- Triggers `bookings_webhook_events` (on `app.bookings`) and `booking_hosts_webhook_events` (on `app.booking_hosts`) add a `webhook_dispatch` job only when an enabled endpoint subscribes to the event. The dispatch handler (`src/server/webhooks/jobs.ts`) records the deliveries and enqueues `webhook_deliver` jobs.
- Every admin change is audited (`webhook.create`, `webhook.update`, `webhook.enable`, `webhook.disable`, `webhook.rotate_secret`, `webhook.test`, `webhook.delete`).
