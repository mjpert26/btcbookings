# n8n workflows

## Salesforce lead creation

Workflow file: `n8n/sf-lead-create.json` (name "BTC Scheduler - SF Lead Create"). Instance: `https://api.bigthinkcapital.com`. Salesforce: `https://bigthink.my.salesforce.com`, REST API v60.0.

BTC Scheduler never calls Salesforce directly. When a booking is confirmed on an event type whose effective Salesforce settings have `create_sf_lead = true`, the booking transaction calls `enqueueSfLeadIfEnabled()` (`src/server/salesforce/jobs.ts`). That sets `bookings.sf_lead_status = 'pending'` and enqueues one `sf_lead_create` job keyed by the booking id. The job handler posts the payload below to this workflow and records the outcome on the booking.

### Settings and inheritance

Settings live in `app.event_type_sf_settings` (admin only via RLS) and are edited through `src/server/salesforce/admin.ts`.

- A language variant uses its parent's row unless `sf_settings` is listed in the variant's `overrides`. `saveSfSettings(..., { overrideParent })` adds or removes that key. Turning the override off keeps the variant's own row for later reuse but stops using it.
- **Lead source (ISO).** In BTC's org "lead source" means the ISO: `csbs__ISO__c`, a lookup to Account. The admin input `isoAccountId` (an Account Id starting `001`) is stored as `static_values.csbs__ISO__c`. The standard `LeadSource` picklist is still available as an ordinary static value (for example `{"LeadSource": "BTC Lead Engine"}`).
- `field_mapping` maps a source key to a Lead field API name. Source keys are `q:<question_key>` for booking questions, or one of: `invitee_name`, `invitee_first_name`, `invitee_last_name`, `invitee_email`, `invitee_phone`, `invitee_timezone`, `booking_id`, `booking_start` (ISO 8601 UTC), `booking_end`, `booking_start_local` (America/New_York, for example `Mon, 10/05/2026, 10:00 AM EDT`), `event_type_name`, `language` (`en`/`es`), `language_name` (`English`/`Spanish`, suitable for `Customers_Preferred_Language__c`), `assigned_host_email`, `assigned_host_name`. Manage tokens and other secrets are never available as sources.
- Precedence per Lead field, lowest to highest: defaults (`FirstName`/`LastName` split from the invitee name, `Email`, `Phone`), then mapped values, then static values. **Static values override mapped values.** Empty answers and null static values are skipped.
- Name split: the first word is `FirstName`, the rest is `LastName` (keeps compound Spanish surnames together). A one-word name becomes `LastName` only.
- `Company` is required by Salesforce. If nothing sets it, the answer to a question keyed `company`, `company_name`, `business_name` or `business` is used, otherwise `Unknown`.
- Field names must match `^[A-Za-z][A-Za-z0-9_]*(__c)?$`. `Id`, `OwnerId`, `Name` and system fields cannot be mapped or set statically. Ids are checked for 15 or 18 characters and their key prefix (ISO `001`, owner `005`/`00G`, campaign `701`).
- Owner modes: `assigned_host` sends the booking's primary host email and n8n resolves the active User by email; `fixed` sends a User (`005`) or Queue (`00G`) Id; `assignment_rules` sends no owner and `autoAssign: true`.
- Optional follow-up steps (all default off): `create_task`, `create_note`, `set_meeting_booked_fields`.

### Request

`POST {N8N_BASE_URL}{N8N_LEAD_WEBHOOK_PATH}` (default `https://api.bigthinkcapital.com/webhook/btc-scheduler/lead`), `Content-Type: application/json`, 20 second client timeout.

Headers:

| Header | Value |
|---|---|
| `X-BTC-Timestamp` | Unix seconds |
| `X-BTC-Signature` | `sha256=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"` |
| `Idempotency-Key` | The booking id |

The secret is `N8N_SIGNING_SECRET` in the app and `BTC_SCHEDULER_SIGNING_SECRET` in n8n (same value). n8n rejects timestamps more than 300 seconds from its clock. Signing code: `src/server/crypto/hmac.ts`.

Body:

```json
{
  "idempotencyKey": "<bookingId>",
  "bookingId": "<bookingId>",
  "lead": { "FirstName": "Ana", "LastName": "Ruiz", "Email": "ana@example.com", "Company": "Ruiz Bakery", "csbs__ISO__c": "001..." },
  "owner": { "mode": "assigned_host", "ownerEmail": "rep@bigthinkcapital.com" },
  "autoAssign": false,
  "campaignId": "701...",
  "meeting": {
    "startUtc": "2026-10-05T14:00:00Z",
    "endUtc": "2026-10-05T14:30:00Z",
    "eventTypeName": "Consult",
    "hostEmail": "rep@bigthinkcapital.com",
    "hostName": "Rep One",
    "isReschedule": false
  },
  "options": { "createTask": false, "createNote": false, "setMeetingBookedFields": false },
  "source": "btc-scheduler"
}
```

`owner` is one of `{mode: "assigned_host", ownerEmail}`, `{mode: "fixed", ownerId}`, `{mode: "assignment_rules"}`. `campaignId` is omitted when not configured.

### Response

Always JSON:

```json
{ "status": "created", "leadId": "00Q...", "matchedRecordId": null, "error": null, "retryable": false, "problems": [] }
```

| `status` | HTTP | Meaning | App behavior |
|---|---|---|---|
| `created` | 200 | Lead inserted | Stores `sf_lead_id`, `sf_lead_status = 'created'` |
| `existing` | 200 | Already processed (Redis hit) | Same as created |
| `duplicate` | 200 | Salesforce rejected the Lead as a duplicate. `leadId` is the matched Lead when the match is a Lead; `matchedRecordId` is the first matched record of any type | Stores the matched Lead Id if any, `sf_lead_status = 'duplicate'`, job ends without retry |
| `error`, `retryable: true` | 503 | Transient (5xx, `UNABLE_TO_LOCK_ROW`, `REQUEST_LIMIT_EXCEEDED`, `SERVER_UNAVAILABLE`, `INVALID_SESSION_ID`, network) | Retries with backoff |
| `error`, `retryable: false` | 422 | Permanent rejection (validation, bad payload) | `sf_lead_status = 'failed'`, no retry |
| `error` (unauthorized) | 401 | Missing raw body, stale timestamp or bad signature | Retries (fixable configuration); then `failed` |

`problems[]` lists follow-up writes that failed after the Lead was created (owner not found, campaign member, note, note link, task, Redis). They do not change `status` and are stored in the job's `result`.

App side, a response without a contract body is classified by HTTP status: 429 honours `Retry-After`, 400/413/422 are permanent, anything else (5xx, 401, 404 when the workflow is inactive) is retried. Retries use the job queue's exponential backoff (30 s doubling to 1 hour, jittered) up to `SF_LEAD_MAX_ATTEMPTS` (default 8), set on the job at enqueue time. When the last attempt fails the booking is marked `sf_lead_status = 'failed'`. Admins can re-queue a dead or failed job with `retrySfLeadJob()`, which keeps the attempt history and raises `max_attempts` to `attempts + SF_LEAD_MAX_ATTEMPTS`.

The handler skips the send (job succeeds with `result.skipped`) when the booking already has `sf_lead_id`, when the booking was cancelled before the send (`sf_lead_status = 'skipped'`), or when lead creation was turned off after enqueue (`skipped`).

### Workflow steps

1. **Lead Webhook** (POST `btc-scheduler/lead`, respond with the Respond node, Raw Body on).
2. **Verify Signature** (Code): reads the raw body from the binary property, checks the timestamp window and HMAC in constant time, then validates the payload (field names, owner Id formats, `Idempotency-Key` equals `bookingId`). Fails closed.
3. **Idempotency Lookup** (Redis GET `btc-scheduler:lead:<bookingId>`). A hit is answered by **Replay Stored Result**: `existing` for a stored created result, `duplicate` for a stored duplicate. Salesforce is not called.
4. **Get SF Token** (Execute Workflow "SF Token Broker", `7wen5ULQg7DBlCvC`).
5. **Resolve Owner** (assigned_host only): `SELECT Id, Name FROM User WHERE Email = '<escaped>' AND IsActive = true LIMIT 1`. Not found is reported in `problems[]` and the Lead is created with the integration user as owner.
6. **Build Lead Body**: adds `OwnerId` (resolved or fixed) and, when `options.setMeetingBookedFields`, the Meeting Booked fields below.
7. **Create Lead**: `POST /sobjects/Lead` with full response and never-error so every error body can be inspected. This node is never retried inside n8n; a retry after an ambiguous failure could insert twice. The app retries the whole request instead, and a second insert is then caught by duplicate detection.
8. **Classify Lead Response** (see duplicate handling).
9. **Remember Result** (Redis SET, 30 day TTL) for `created` and `duplicate`, immediately after the insert.
10. Optional, only when the Lead was created: **Add Campaign Member** (`campaignId`), **Encode Note** / **Create ContentNote** / **Link Note To Lead** (`options.createNote`), **Create Task** (`options.createTask`).
11. **Final Result** inspects every write and builds the response; **Respond** returns it.

### Sforce-Auto-Assign

The header is sent on every Lead insert: `TRUE` only when `autoAssign` is true (owner mode `assignment_rules`), `FALSE` otherwise. Salesforce applies the default assignment rule to API inserts unless told not to, which previously re-assigned leads away from the rep they were booked with. Sending `FALSE` explicitly keeps the owner chosen by the app. The Task insert also sends `FALSE`, matching the shared Calendly writer.

### Duplicate handling

Verified read-only against production metadata on 2026-10-02:

- **Standard duplicate rules.** `Standard_Lead_Duplicate_Rule` and `Standard_Matching_Rule_for_Leads_on_Accounts` are active on Lead. The workflow does not send `Sforce-Duplicate-Rule-Header`, so a match is returned as `DUPLICATES_DETECTED`; matched Ids are read from `duplicateResult.matchResults[].matchRecords[].record.Id`.
- **DuplicateCheckHandler** (called from the `LeadDuplicateTrigger` before insert/update trigger). It matches on normalized EIN, SSN, cleaned phone and email across Leads, merchant Accounts, Opportunities and Contacts, and blocks with `addError()`. Over the REST API this is `FIELD_CUSTOM_VALIDATION_EXCEPTION` with either "Duplicate <reason> detected. This record matches existing <Object> ... Open here: <org URL>/<Id>" or the "There may be active Opportunities present for this merchant!" warning (which also mentions the Duplicate Check Bypass permission set). Any error message containing "duplicate" (case-insensitive) is classified as `duplicate`; the record Id is taken from the link. The matched record can be a Lead (`00Q`), Account (`001`), Contact (`003`) or Opportunity (`006`); only a Lead Id is returned as `leadId`. Names and owners in the message are not passed back.
- **Allowed with a flag.** The handler lets the insert succeed when the only matches are funded Opportunities, stale Opportunities (which it auto-declines), or when the running user holds the `Bypass_Duplicate_Check` custom permission. In those cases `LeadDuplicateAuditTrigger` attaches a ContentNote titled "Possible Duplicate Detected - <timestamp>" and publishes `Duplicate_Override__e`. No checkbox such as `Is_Duplicate__c` exists on Lead (a numeric `Duplicate_Count__c` does, maintained elsewhere). The workflow reports these as `created`. Make sure the token broker's integration user does **not** hold the bypass permission, or duplicates will be created silently.

### Idempotency

Three layers: the app (`bookings.sf_lead_id` checked before every send; one job per booking via the unique `(kind, idempotency_key)`), Redis in n8n (30 days), and Salesforce duplicate detection on email. No Lead field holds the booking id today. `External_Lead_ID__c` and `sfleadcaphfprod__External_Lead_ID__c` exist but belong to other integrations and are not reused. **Recommended addition:** a unique, external-id text field `External_Booking_Id__c` on Lead. With it the workflow can add a SOQL lookup before the insert (and the app can map `booking_id` to it).

### Relationship to "Calendly - SF Meeting Booked (shared)"

The existing shared writer (`yVjvBOx5E3Zc36rX`) patches an **existing** Lead for Calendly bookings: Status `Working - Contacted`, `csbs__Status_Detail__c` `Meeting Booked`, `Meeting_booked_time__c`, `Meeting_Booked__c = true`, `Do_Not_Contact__c = false`, `OwnerId`, `csbs__ISO__c`, `MobilePhone`, then a "Meeting Booked" ContentNote, a "Meeting Booked" Task and a `Lead_Log_Detail__c` row. This workflow **creates** a new Lead. Its optional steps mirror the shared writer's conventions:

| Shared writer | This workflow |
|---|---|
| Status / Status Detail / Meeting Booked fields | Set in the insert body when `options.setMeetingBookedFields` |
| ContentNote "Meeting Booked" (time, agent, source) | `options.createNote`; same format, source "BTC Scheduler - <event type>" |
| Task "Meeting Booked" with `rcsfl__call_start_time__c` | `options.createTask` |
| `Lead_Log_Detail__c` (matched existing only) | Not written (no existing Lead is matched) |
| Return Result with `problems[]` | Final Result with `problems[]` |

The two must not both act on the same booking. BTC Scheduler bookings never go through Calendly, so in practice they do not overlap; if Calendly and BTC Scheduler pages run side by side for the same event, keep lead creation enabled on only one of them. The shared writer's Task node uses the "Salesforce Brian" credential because of a license gap for the integration user; this workflow uses the token broker for every call. If Task inserts fail with a license error, switch the **Create Task** node to that credential.

### n8n configuration

- Environment variable: `BTC_SCHEDULER_SIGNING_SECRET` (same value as the app's `N8N_SIGNING_SECRET`). The Code nodes use `require('crypto')`, which the token broker already relies on (`NODE_FUNCTION_ALLOW_BUILTIN` must include `crypto`).
- Credentials: Redis "api n8n redis" (`4i3m00SkLAc8SzwE`). Salesforce access comes from the "SF Token Broker" sub-workflow; no Salesforce credential is stored on any node.
- The token broker's caller policy is `workflowsFromSameOwner`, so this workflow must be owned by the same n8n project as the broker.
- Recommended workflow settings after import: the instance's standard error workflow (the shared writer uses `Q3Ld5IrQCtGimErY`), and consider not saving successful execution data, since payloads contain invitee contact details.

App environment: `N8N_BASE_URL`, `N8N_LEAD_WEBHOOK_PATH`, `N8N_SIGNING_SECRET`, `SF_LEAD_MAX_ATTEMPTS`.

### Import and test

1. In n8n, Workflows, Import from File, select `n8n/sf-lead-create.json`. Confirm the Redis credential binding and that **Get SF Token** points at `7wen5ULQg7DBlCvC`.
2. Set `BTC_SCHEDULER_SIGNING_SECRET` in the n8n environment and restart n8n if required.
3. Test with the webhook's test URL (`/webhook-test/btc-scheduler/lead`) before activating. Sign a body locally:

   ```bash
   SECRET='<shared secret>'
   BODY='{"idempotencyKey":"<uuid>","bookingId":"<uuid>","lead":{"LastName":"Test","Company":"BTC Scheduler Test","Email":"<test address>","Testing__c":true},"owner":{"mode":"fixed","ownerId":"005..."},"autoAssign":false,"meeting":{"startUtc":"2026-10-05T14:00:00Z","endUtc":"2026-10-05T14:30:00Z","eventTypeName":"Test","hostEmail":null,"hostName":null,"isReschedule":false},"options":{"createTask":false,"createNote":false,"setMeetingBookedFields":false},"source":"btc-scheduler"}'
   TS=$(date +%s)
   SIG="sha256=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
   curl -sS -X POST "https://api.bigthinkcapital.com/webhook-test/btc-scheduler/lead" \
     -H "Content-Type: application/json" -H "X-BTC-Timestamp: $TS" -H "X-BTC-Signature: $SIG" \
     -H "Idempotency-Key: <uuid>" --data-raw "$BODY"
   ```

   Expected: `created` with a Lead Id. Sending the same body again returns `existing` with the same Id. A changed body or old timestamp returns 401. A second booking id with the same email returns `duplicate`.
4. Run the first live test in a sandbox, or in production only with approval, using `Testing__c = true` and a recognisable test email, then delete the test Lead and its Redis key (`btc-scheduler:lead:<uuid>`).
5. Activate the workflow, then enable `create_sf_lead` on one event type.
