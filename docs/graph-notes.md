# Microsoft Graph: confirmed facts and how the app uses them

Checked against Microsoft Learn on 2026-10-02. Each section lists the source page and the
behavior the code relies on. Re-check these pages before changing the sync design.

## 1. Subscription lifetime (Outlook events, basic notifications)

Source: https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0
(page updated 2026-09-17), section "Subscription lifetime".

- Outlook message, event and contact: **10,080 minutes (under seven days)**. With resource
  data (rich notifications) the limit is 1,440 minutes. The app uses basic notifications.
- Any expirationDateTime under 45 minutes from the request is raised to 45 minutes.
- `clientState` is optional on the resource but required by the webhook guide; maximum
  length 128 characters.
- `lifecycleNotificationUrl` is only required for Teams resources (over 1 hour); it is
  optional for Outlook but recommended, and it cannot be added to an existing subscription
  by PATCH (delete and recreate instead).

App behavior (`src/server/graph/subscriptions.ts`):
- Requests `now + 10,065 minutes` (maximum minus 15 minutes).
- `changeType: "created,updated,deleted"`, `resource: "me/events"`.
- The 6-hour cron (`/api/cron/graph-subscriptions`) enqueues renewal for subscriptions that
  expire within 48 hours and creation for healthy connections without one.
- Renewal is `PATCH /subscriptions/{id}` with only `expirationDateTime`. A 404 means Graph
  dropped it, so the app creates a new one.
- Duplicate subscriptions (same resource and changeType) fail with `409 Conflict`. The app
  then lists `/subscriptions`, deletes its own stale one (same notificationUrl and resource)
  and creates again.

## 2. Webhook delivery, validation and clientState

Source: https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
(updated 2026-04-22).

- Validation: Graph POSTs to the notification URL with `?validationToken=...`. The endpoint
  must answer within **10 seconds** with `200 OK`, `Content-Type: text/plain`, and the
  URL-decoded token as the body. Both `notificationUrl` and `lifecycleNotificationUrl` are
  validated.
- Delivery: a notification counts as delivered on any 2xx within **3 seconds**. The guide
  recommends validating, queueing, and returning `202 Accepted`. Non-2xx or timeouts are
  retried with backoff for up to 4 hours.
- Throttling: more than 10% of responses over 3 seconds in 10 minutes marks the endpoint
  "slow" (10-minute delays); more than 15% over 10 seconds marks it "drop" (notifications
  discarded for 10 minutes).
- Each notification carries `subscriptionId`, `clientState`, `changeType`, `resource`,
  `resourceData`, `tenantId`. The app must check `clientState`.

App behavior (`src/server/graph/notifications.ts`, routes under `src/app/api/graph/`):
- The clientState is 32 random bytes (base64url, 43 characters). Only its SHA-256 hash is
  stored (`calendar_connections.client_state_hash`). Verification hashes the received value
  and compares hashes in constant time. Renewal does not need the plaintext, and a
  recreated subscription gets a new value, so no encrypted copy is kept.
- Each item is verified separately. Unknown subscription ids run the same comparison
  against a dummy hash. Every well-formed request gets an empty `202`, whatever the outcome.
- Valid notifications enqueue `graph_delta_sync` with idempotency key
  `delta:<userId>:<30-second bucket>` and `run_at` at the end of the bucket, so a burst of
  changes becomes one sync.

## 3. Lifecycle notifications

Source: https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events
(updated 2026-04-07).

- Types: `reauthorizationRequired` (all resources), `subscriptionRemoved` (Outlook message,
  event, contact; Teams chatMessage), `missed` (Outlook message, event, contact).
- Payload items have `subscriptionId`, `subscriptionExpirationDateTime`, `tenantId`,
  `clientState`, `lifecycleEvent`. Respond `202 Accepted`, then validate.
- reauthorizationRequired: call either `POST /subscriptions/{id}/reauthorize` or
  `PATCH /subscriptions/{id}` with a new expirationDateTime (which reauthorizes and renews).
  Do not send both for the same subscription within 10 minutes.
- subscriptionRemoved: create a new subscription, then resync (delta) to recover changes.
- missed: run a full resync of the resource (delta).

App behavior (`/api/graph/lifecycle`):
- reauthorizationRequired: sets `subscription_expires_at = now()` and enqueues
  `graph_subscription_ensure`, which PATCHes the expiration (one call, no separate
  reauthorize). The idempotency key is bucketed per 10 minutes to respect the guidance above.
- subscriptionRemoved: clears the stored subscription id and hash, then enqueues
  `graph_subscription_ensure`. Creation also enqueues a delta sync.
- missed: enqueues `graph_delta_sync`.

## 4. calendarView and calendarView/delta

Sources:
- https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0 (updated 2026-05-14)
- https://learn.microsoft.com/en-us/graph/delta-query-overview (updated 2026-05-14)

- `GET /me/calendarView/delta?startDateTime=...&endDateTime=...`. Query parameters are given
  only on the first request; later pages and rounds use the returned `@odata.nextLink` or
  `@odata.deltaLink` URL as-is.
- **Not supported on calendarView delta: `$select`, `$expand`, `$filter`, `$orderby`,
  `$search`.** So extended properties are not available in delta results. The app recognizes
  its own events by the event id stored on `booking_hosts.graph_event_id`, by iCalUId, and by
  `transactionId` (which delta does return).
- Headers: `Prefer: odata.maxpagesize={x}` and `Prefer: outlook.timezone` (UTC when absent).
  The app sends `outlook.timezone="UTC", odata.maxpagesize=200`.
- Removed items come back as `{ "id": ..., "@removed": { "reason": "deleted" } }`. A round
  can also report items outside the date range; the app filters to its window.
- The same entity can appear more than once in a round; the last occurrence wins.
- Sync reset: `410 Gone` (with a Location header for a fresh round). Expired Outlook delta
  tokens return a 4xx with a code such as `syncStateNotFound`. Outlook delta token lifetime
  is not fixed (it depends on an internal cache). The app treats 410 and 4xx with
  `syncStateNotFound`, `syncStateInvalid` or `resyncRequired` as "start a full round".

App behavior (`src/server/graph/delta.ts`):
- Window: UTC today minus 1 day to UTC today plus 60 days. A delta link is bound to its
  window, so when the window moves (daily) the next sync is a full round for the new window.
- Full round: upserts every event and deletes cached rows in the window that were not
  returned. Incremental round: upserts changed events and deletes removed ones.
- The delta link is stored encrypted (`calendar_connections.delta_link_enc`, AES-GCM with the
  user id as AAD). Absolute next and delta links are only followed on graph.microsoft.com.
- The 15-minute cron (`/api/cron/graph-delta`) enqueues a sync for every healthy connection.
- `syncCalendarWindow` in `busy.ts` uses plain calendarView (which does support `$select`
  and `$expand`) to rebuild an arbitrary window, expanding the BtcBookingId property.

## 5. getSchedule

Source: https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0
(updated 2026-05-19).

- `POST /me/calendar/getSchedule` with `schedules` (SMTP addresses), `startTime` and
  `endTime` (dateTimeTimeZone), optional `availabilityViewInterval` (minutes; default 30,
  minimum 5, maximum 1440).
- Response `value[]` of scheduleInformation: `scheduleId`, `availabilityView` (one digit per
  interval: 0 free, 1 tentative, 2 busy, 3 oof, 4 workingElsewhere), `scheduleItems[]`
  (`status`, `start`, `end`, and optionally `subject`, `location`, `isPrivate`),
  `workingHours`, and `error` per schedule.
- Times in the response are UTC unless `Prefer: outlook.timezone` is sent.
- More than 1,000 entries in the period returns error 5006.

App behavior (`liveFreeBusy` in `busy.ts`): one call per host with that host's own token, in
parallel, each bounded to 2 seconds (including any token refresh) with no retries. Items with
status `free` are dropped. A host whose call fails or times out falls back to the
`busy_blocks` cache. Live results are returned to the caller, not written to the cache
(schedule items carry no event id).

## 6. Creating the app's events

Sources:
- https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0 (updated 2026-08-03)
- https://learn.microsoft.com/en-us/graph/outlook-calendar-online-meetings (updated 2025-08-06)
- https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-post-singlevalueextendedproperties?view=graph-rest-1.0 (updated 2026-09-02)
- https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-get?view=graph-rest-1.0 (updated 2026-09-02)

- Teams meeting: set `isOnlineMeeting: true` and `onlineMeetingProvider: "teamsForBusiness"`
  (the calendar's `allowedOnlineMeetingProviders` must include it). The join link is
  `onlineMeeting.joinUrl` on the returned event. `onlineMeetingUrl` is being deprecated.
  Once online, `onlineMeetingProvider` cannot be changed and `isOnlineMeeting` cannot be set
  back to false, so updates omit the provider.
- `transactionId`: an optional client-supplied id that lets the server avoid duplicate
  creates on client retries. The app sets it to the booking id.
- Extended property on create: include
  `singleValueExtendedProperties: [{ "id": "String {guid} Name BtcBookingId", "value": "<bookingId>" }]`
  in the POST body. The response does not echo the property; read it with
  `$expand=singleValueExtendedProperties($filter=id eq '<property id>')`.
- Filtering by a string extended property:
  `GET /me/events?$filter=singleValueExtendedProperties/Any(ep: ep/id eq '<property id>' and ep/value eq '<value>')`.
  Spaces, colons and slashes in the filter must be URL-encoded (the app encodes spaces as
  `%20`, not `+`). The name part of the id is case-sensitive; the value comparison is not.

App behavior (`src/server/graph/jobs.ts`, `event-payload.ts`):
- Property id: `String {66f5a359-4659-4638-81a3-d1d2b2f5c5b4} Name BtcBookingId`.
- graph_event_upsert: PATCH the stored event; if none is stored, search by the property
  filter (finds an event created by an earlier attempt whose id was not saved) and PATCH it;
  otherwise POST with `transactionId`. A PATCH 404 falls through to create.
- Times are sent as `{ dateTime: "yyyy-MM-ddTHH:mm:ss", timeZone: "UTC" }`.
- graph_event_delete: `DELETE /me/events/{id}` on the organizer's calendar (Outlook sends
  cancellations to attendees). 404 and 410 count as success.

## 7. Throttling

Source: https://learn.microsoft.com/en-us/graph/throttling (general guidance, not re-read in
detail on this date).

The client retries 429, 503 and 504 up to 3 times, honoring `Retry-After` (seconds or HTTP
date) when it is 20 seconds or less. Longer waits are not slept in-process: the job fails with
`RetryAfterError` and the worker reschedules it after the given delay. A 401 triggers one
forced token refresh and one retry.
