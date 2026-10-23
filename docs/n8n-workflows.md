# n8n workflows

BTC Scheduler talks to Salesforce only through n8n on api.bigthinkcapital.com. Both workflows authenticate to Salesforce through the existing SF Token Broker sub-workflow (`7wen5ULQg7DBlCvC`). Importable JSON is in `/n8n`.

## Salesforce leads

Workflow file: `n8n/sf-lead-create.json` (name "BTC Scheduler - SF Lead Create"). Instance: `https://api.bigthinkcapital.com`. Salesforce: `https://bigthink.my.salesforce.com`, REST API v60.0.

BTC Scheduler never calls Salesforce directly. When a booking is confirmed on an event type whose effective Salesforce settings have `create_sf_lead = true` (the "Send bookings to Salesforce" switch), the booking transaction marks the booking `sf_lead_status = 'pending'` and enqueues one `sf_lead_create` job keyed by the booking id. The job handler (`src/server/salesforce/jobs.ts`) posts the payload below to this workflow and records the outcome on the booking. Depending on the event type's lead mode, the workflow updates the invitee's existing Lead the way the Calendly lead flow does, creates a Lead, or skips the booking.

### Lead modes

`event_type_sf_settings.lead_mode`, set under "Lead handling" on the event type's Salesforce settings page (`/admin/event-types/<id>/salesforce`) and shown on Admin > Lead routing:

| Mode | Admin label | Calendly mapping | Behavior |
|---|---|---|---|
| `match_or_create` (default for new settings) | Update the invitee's Lead, or create one | `mode: "create"` | An open Lead with the invitee's email is updated. When the only matches are converted Leads, the booking is skipped. With no Lead, a Lead is created and then updated by the shared writer. |
| `update_only` | Update the invitee's Lead only | `mode: "update"` | An open Lead is updated. Otherwise the booking is skipped. Never creates a Lead. |
| `create` | Always create a new Lead | none (original BTC Scheduler behavior) | Always inserts a new Lead through the original path. Reschedules do not call Salesforce. |

Settings rows that existed before migration `20261023110000_sf_lead_modes.sql` were given `create`, so their behavior did not change. Switch a page to `match_or_create` to get the Calendly behavior.

"Updated" means the shared writer **Calendly — SF Meeting Booked (shared)** (`yVjvBOx5E3Zc36rX`) ran on the Lead. It resolves the rep's User by email and:

- patches the Lead (header `Sforce-Auto-Assign: false`): Status `Working - Contacted`, `csbs__Status_Detail__c` `Meeting Booked`, `Meeting_booked_time__c` (meeting start), `Meeting_Booked__c = true`, `Do_Not_Contact__c = false`, plus `OwnerId` (the rep; owner mode `assigned_host` only), `csbs__ISO__c` (when the page has an ISO) and `MobilePhone` (when known);
- creates a ContentNote "Meeting Booked" (or "Meeting Booked - Rescheduled") with the time in America/New_York, the agent, the source label and the invitee's notes (HTML-escaped), linked to the Lead;
- creates a Task "Meeting Booked" (Status Open, `WhoId` the Lead, `OwnerId` the rep, `rcsfl__call_start_time__c` the meeting start);
- for a matched Lead only (not one this workflow just created), inserts a `Lead_Log_Detail__c` row (Outcome `Matched Existing`, `Is_Reschedule__c`, and `Prior_ISO__c` when the ISO changed).

### Reschedules

A reschedule, through the invitee's manage link or through the REST API and MCP reschedule (which use the same code path, `rescheduleByInvitee`), creates a new booking that carries the original booking's `sf_lead_id`.

- `create` mode: no Salesforce call, as before. The original booking's job, if it has not run yet, still runs; it uses the hosts the booking had at the time of the reschedule, and its outcome is copied to the new booking.
- Other modes: inside the reschedule transaction, one `sf_lead_create` job for the new booking with payload `{ "bookingId": "<new id>", "isReschedule": true }`, keyed by the new booking's id, and `sf_lead_status = 'pending'` on the new booking. n8n treats a reschedule as update only: the open Lead gets the new meeting time and a "Meeting Booked - Rescheduled" note and task; with no open Lead the job ends as `skipped`.
- If the original booking's own job has not run yet (pending, or waiting for a retry) and the booking has no Lead, that job is superseded: it is marked succeeded with `result.skipped = "superseded_by_reschedule"`, the original booking gets `sf_lead_status = 'skipped'`, and the new booking's job takes over its intent (no `isReschedule`), so the invitee is matched or created once, with the new time.
- The newest booking's job owns the Salesforce work for the invitee. When an earlier booking's job runs after the reschedule (a retry, or a job that was already running when the invitee rescheduled), it ends with `result.skipped = "superseded_by_reschedule"` without calling n8n, and only the earlier booking's own status changes.
- A job never overtakes the job of an earlier booking in the same reschedule chain. When it runs, it first supersedes earlier jobs that are still waiting (pending, or waiting for a retry). While an earlier job is running, the new job waits and checks again every 60 seconds; waiting does not use up its attempts.
- If the original booking's first-booking job never produced a Lead (it was superseded, or it is dead after failing, but not as a `duplicate`), a reschedule job takes over its intent: it drops `isReschedule` from its payload, is sent as a first booking, and records `result.tookOverOriginal = true`. This is decided when the reschedule is queued and again when the job runs.
- An outcome is copied only to later bookings in the chain that have no `sf_lead_create` job of their own (for example a reschedule in `create` mode). A later booking with its own job keeps its own outcome.
- If the mode changes to `create` after a reschedule job was queued, the job ends with `result.skipped = "reschedule_in_create_mode"`.

### Host reassignments

A host change made by the `booking_reassign` job (queue removal or admin pause on a team with removal policy `reassign`) sends nothing to Salesforce, in every lead mode and owner mode. The Lead's `OwnerId` and its "Meeting Booked" Task stay with the rep who was removed, even with owner mode `assigned_host`. Change the owner in Salesforce if the new rep should own the Lead. A later reschedule of the booking sends the usual update, which moves the Lead to the booking's host at that time (`set_owner`, owner mode `assigned_host` only).

Imported Calendly bookings never produce Salesforce work: the `jobs_skip_imported_bookings` trigger drops every job that carries their booking id, the reschedule rule refuses an imported original, and the handler ignores a job whose booking is imported.

### Settings and inheritance

Settings live in `app.event_type_sf_settings` (admin only via RLS) and are edited through `src/server/salesforce/admin.ts`. Every save is audited in the same transaction: `sf_settings.update` records only the fields that changed (no entry when nothing changed), and `sf_settings.toggle` records turning Salesforce on or off.

- A language variant uses its parent's row, including the lead mode, unless `sf_settings` is listed in the variant's `overrides`. `saveSfSettings(..., { overrideParent })` adds or removes that key. Turning the override off keeps the variant's own row for later reuse but stops using it.
- `leadMode` in the admin input is optional: when omitted, an existing row keeps its mode and a new row gets `match_or_create`.
- **Lead source (ISO).** In BTC's org "lead source" means the ISO: `csbs__ISO__c`, a lookup to Account. The admin input `isoAccountId` (an Account Id starting `001`) is stored as `static_values.csbs__ISO__c`. The standard `LeadSource` picklist is still available as an ordinary static value (for example `{"LeadSource": "BTC Lead Engine"}`).
- `field_mapping` maps a source key to a Lead field API name. Source keys are `q:<question_key>` for booking questions, or one of: `invitee_name`, `invitee_first_name`, `invitee_last_name`, `invitee_email`, `invitee_phone`, `invitee_timezone`, `booking_id`, `booking_start` (ISO 8601 UTC), `booking_end`, `booking_start_local` (America/New_York, for example `Mon, 10/05/2026, 10:00 AM EDT`), `event_type_name`, `language` (`en`/`es`), `language_name` (`English`/`Spanish`, suitable for `Customers_Preferred_Language__c`), `assigned_host_email`, `assigned_host_name`. Manage tokens and other secrets are never available as sources. Mapped and static values are used when a Lead is inserted; the update of an existing Lead sets only the shared writer's fields.
- Precedence per Lead field, lowest to highest: defaults (`FirstName`/`LastName` split from the invitee name, `Email`, `Phone`), then mapped values, then static values. **Static values override mapped values.** Empty answers and null static values are skipped.
- Name split: the first word is `FirstName`, the rest is `LastName` (keeps compound Spanish surnames together). A one-word name becomes `LastName` only.
- `Company` is required by Salesforce. If nothing sets it, the answer to a question keyed `company`, `company_name`, `business_name` or `business` is used, otherwise `Unknown`.
- Field names must match `^[A-Za-z][A-Za-z0-9_]*(__c)?$`. `Id`, `OwnerId`, `Name` and system fields cannot be mapped or set statically. Ids are checked for 15 or 18 characters and their key prefix (ISO `001`, owner `005`/`00G`, campaign `701`).
- Owner modes: `assigned_host` sends the booking's primary host email and n8n resolves the active User by email; `fixed` sends a User (`005`) or Queue (`00G`) Id; `assignment_rules` sends no owner and `autoAssign: true`. When an existing Lead is updated, only `assigned_host` moves it to the rep (`set_owner`); with the other owner modes the Lead keeps its owner.
- Optional follow-up steps (all default off): `create_task`, `create_note`, `set_meeting_booked_fields`. In `create` mode they run after the insert. In the other modes the shared writer always sets the Meeting Booked fields and adds the note and task, so `create_note` and `create_task` are not used (`set_meeting_booked_fields` still applies to the insert).

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
  "mode": "match_or_create",
  "isReschedule": false,
  "lead": { "FirstName": "Ana", "LastName": "Ruiz", "Email": "ana@example.com", "Phone": "+13055550100", "Company": "Ruiz Bakery", "csbs__ISO__c": "001..." },
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
  "noteText": "We have two trucks and a second location.",
  "sourceLabel": "Acme Partners BTC Scheduler",
  "mobilePhone": "+13055550100",
  "isoName": "Acme Partners",
  "source": "btc-scheduler"
}
```

`owner` is one of `{mode: "assigned_host", ownerEmail}`, `{mode: "fixed", ownerId}`, `{mode: "assignment_rules"}`. `campaignId` is omitted when not configured.

| Field | Meaning |
|---|---|
| `mode` | `match_or_create`, `update_only` or `create`. A body without `mode` (an app version before lead modes) is treated as `create`. |
| `isReschedule` | `true` for the job of a rescheduled booking; the same value is in `meeting.isReschedule`. A reschedule is always update only. |
| `noteText` | The answer to the first free-text (text or textarea) question, in question order, whose key (underscores read as spaces) or English label contains "help prepare", "anything that will help", "additional" or "notes" (case-insensitive, the Calendly patterns). Answers to questions that were deleted are matched by key, after the others. At most 5000 characters; `null` when nothing matches. |
| `sourceLabel` | `<partner display name> BTC Scheduler` for a team (partner) page, using `teams.page_settings.displayName` or else the team name; `BTC Scheduler - <event type name>` for an individual page. |
| `mobilePhone` | The invitee's phone, which is also the number merchant text reminders go to; `null` when none. |
| `isoName` | The partner display name, when the page belongs to a team and has an ISO; otherwise `null`. |

In `match_or_create` and `update_only`, `lead.Email` (the invitee's email) and `meeting.hostEmail` (the rep) are required. The app fails the job permanently, with an "Invalid Salesforce settings" error, when such a booking has no assigned host.

### Response

Always JSON:

```json
{ "status": "updated", "leadId": "00Q...", "matchedRecordId": null, "error": null, "retryable": false, "problems": [] }
```

| `status` | HTTP | Meaning | App behavior |
|---|---|---|---|
| `created` | 200 | Lead inserted (any mode; in `match_or_create` the shared writer then ran on it) | Stores `sf_lead_id`, `sf_lead_status = 'created'` |
| `existing` | 200 | Already processed: Redis hit for a created Lead | Same as created |
| `updated` | 200 | An open Lead with the invitee's email was matched and the shared writer ran on it. `leadId` is that Lead. Also returned for a Redis hit on an earlier update | Stores `sf_lead_id`, `sf_lead_status = 'updated'` |
| `skipped` | 200 | Nothing to write. `reason`: `converted_lead` (`matchedConvertedId` is the converted Lead), `no_open_lead` (update only) or `reschedule_no_open_lead` | `sf_lead_status = 'skipped'`; `reason` and `matchedConvertedId` are stored in the job result; the job succeeds |
| `duplicate` | 200 | Salesforce rejected an insert as a duplicate. `leadId` is the matched Lead when the match is a Lead; `matchedRecordId` is the first matched record of any type | Stores the matched Lead Id if any, `sf_lead_status = 'duplicate'`, job ends without retry |
| `error`, `retryable: true` | 503 | Transient (5xx, `UNABLE_TO_LOCK_ROW`, `REQUEST_LIMIT_EXCEEDED`, `SERVER_UNAVAILABLE`, `INVALID_SESSION_ID`, network), a failed Lead lookup, or the shared writer failing outright | Retries with backoff |
| `error`, `retryable: false` | 422 | Permanent rejection (validation, bad payload, malformed lookup), or the shared writer skipping the update (missing required input) or returning an unexpected result | `sf_lead_status = 'failed'`, no retry |
| `error` (unauthorized) | 401 | Missing raw body, stale timestamp or bad signature | Retries (fixable configuration); then `failed` |

`problems[]` lists follow-up writes that failed after the Lead was created or matched. They do not change `status` and are stored in the job's `result`. Insert path: owner not found, campaign member, note, note link, task, Redis. Update path: every entry of the shared writer's `problems[]`, plus "Lead update (status and Meeting Booked fields) failed", "Note create failed", "Task create failed" and "Assigned host is not an active Salesforce user; Lead owner not changed" when the writer reports `patch_ok`, `note_ok`, `task_ok` or `rep_resolved` as false.

App side, a response without a contract body is classified by HTTP status: 429 honours `Retry-After`, 400/413/422 are permanent, anything else (5xx, 401, 404 when the workflow is inactive) is retried. Retries use the job queue's exponential backoff (30 s doubling to 1 hour, jittered) up to `SF_LEAD_MAX_ATTEMPTS` (default 8), set on the job at enqueue time. When the last attempt fails the booking is marked `sf_lead_status = 'failed'`. Admins can re-queue a dead or failed job with `retrySfLeadJob()`, which keeps the attempt history, raises `max_attempts` to `attempts + SF_LEAD_MAX_ATTEMPTS` and sets the booking back to `pending` (for a reschedule job even though the booking already carries a Lead). It refuses (SQLSTATE `BTC01`) the job of a booking that was rescheduled when a later booking in the chain has its own lead job; retry that job instead.

The handler skips the send (job succeeds with `result.skipped`) when a first booking already has `sf_lead_id` (`already_has_lead`; reschedule jobs are sent anyway), when the booking was cancelled before the send (`booking_cancelled`, `sf_lead_status = 'skipped'`), when Salesforce was turned off after enqueue (`lead_creation_disabled`), when a reschedule job meets `create` mode (`reschedule_in_create_mode`), or when the booking is imported (`imported_booking`).

### Workflow steps

1. **Lead Webhook** (POST `btc-scheduler/lead`, respond with the Respond node, Raw Body on).
2. **Verify Signature** (Code): reads the raw body from the binary property, checks the timestamp window and HMAC in constant time, then validates the payload (field names, owner Id formats, `Idempotency-Key` equals `bookingId`, `mode`, `isReschedule` and the text fields; in `match_or_create` and `update_only` also `lead.Email` and `meeting.hostEmail`). Fails closed. It lowercases the invitee's email and escapes it for SOQL exactly like the Calendly lead flow: backslash first (`\` becomes `\\`), then single quote (`'` becomes `\'`).
3. **Idempotency Lookup** (Redis GET `btc-scheduler:lead:<bookingId>`). A hit is answered by **Replay Stored Result**: `existing` for a stored created result, `updated` for a stored update, `duplicate` for a stored duplicate. Salesforce is not called.
4. **Get SF Token** (Execute Workflow "SF Token Broker", `7wen5ULQg7DBlCvC`).
5. **Match Existing Lead?**: `create` mode continues at step 9 (the original path, unchanged).
6. **Find Existing Lead**: `SELECT Id, Email, IsConverted, Status, OwnerId, csbs__ISO__c, CreatedDate FROM Lead WHERE Email = '<escaped>' ORDER BY CreatedDate DESC LIMIT 5` (full response, never errors, up to 3 tries on network failures).
7. **Decide Action** (Code), the Calendly rules: effective mode is `update` for a reschedule, otherwise `update` for `update_only` and `create` for `match_or_create`. The newest open (`IsConverted = false`) Lead is updated (`created = false`). Otherwise a converted Lead means skip ("Existing CONVERTED lead found - not creating a duplicate"). Otherwise effective mode `create` creates the Lead (`created = true`), and effective mode `update` skips. A failed lookup is an error (retryable for 5xx, 429, network and session errors).
8. **Use Existing Lead?** goes to step 13; **Create New Lead?** goes to step 9; anything else (skip or error) goes to **Final Result**.
9. **Owner By Email?** / **Resolve Owner** (assigned_host only): `SELECT Id, Name FROM User WHERE Email = '<escaped>' AND IsActive = true LIMIT 1`. Not found is reported in `problems[]` and the Lead is created with the integration user as owner.
10. **Build Lead Body**: adds `OwnerId` (resolved or fixed) and, when `options.setMeetingBookedFields`, the Meeting Booked fields.
11. **Create Lead**: `POST /sobjects/Lead` with full response and never-error so every error body can be inspected. This node is never retried inside n8n; a retry after an ambiguous failure could insert twice. The app retries the whole request instead, and a second insert is then caught by duplicate detection (or, in `match_or_create`, by the email lookup). **Classify Lead Response** (see duplicate handling) and **Remember Result** (Redis SET, 30 day TTL) for `created` and `duplicate`, immediately after the insert.
12. Only when the Lead was created: **Add Campaign Member** (`campaignId`); in `create` mode **Encode Note** / **Create ContentNote** / **Link Note To Lead** (`options.createNote`) and **Create Task** (`options.createTask`). In the other modes **Write Meeting Booked?** sends the new Lead to step 13.
13. **Build Writer Input** (Code) maps the payload to the shared writer's input (table below), **Write Meeting Booked** (Execute Workflow `yVjvBOx5E3Zc36rX`, mode each, waits for the result, passthrough input, continues on error), then for a matched Lead **Remember Update** (Redis SET `{"status":"updated"}`, 30 day TTL) so a repeated request does not add a second note and task.
14. **Final Result** inspects every write and builds the response; **Respond** returns it.

Shared writer input (Calendly contract, built by **Build Writer Input**; absent values are empty strings):

| Field | Value |
|---|---|
| `lead_id` | Matched Lead, or the Lead just created |
| `rep_email`, `rep_name` | `meeting.hostEmail` (lowercased), `meeting.hostName` |
| `iso_id`, `iso_name` | `lead.csbs__ISO__c`, `isoName` |
| `source_label` | `sourceLabel` |
| `set_owner` | `true` only for owner mode `assigned_host` |
| `start_time`, `end_time` | `meeting.startUtc`, `meeting.endUtc` |
| `event_type` | `meeting.eventTypeName` (the event type name) |
| `calendly_uri` | `btc-scheduler:<bookingId>` |
| `invitee_name`, `invitee_email` | `FirstName LastName`, the lowercased `lead.Email` |
| `invitee_phone`, `invitee_company` | `lead.Phone`, `lead.Company` (`Unknown` when empty) |
| `mobile_phone`, `note_text` | `mobilePhone`, `noteText` |
| `write_calendar_event`, `unmapped` | `false`, `false` (BTC Scheduler writes Outlook itself, and every page is configured) |
| `effective_mode`, `is_reschedule`, `created` | From **Decide Action** |
| `existing_iso` | The matched Lead's `csbs__ISO__c` (empty for a created Lead) |

### Sforce-Auto-Assign

The header is sent on every Lead insert: `TRUE` only when `autoAssign` is true (owner mode `assignment_rules`), `FALSE` otherwise. Salesforce applies the default assignment rule to API inserts unless told not to, which previously re-assigned leads away from the rep they were booked with. Sending `FALSE` explicitly keeps the owner chosen by the app. The Task insert also sends `FALSE`, matching the shared Calendly writer, which also sends `FALSE` on its Lead update.

### Duplicate handling

Verified read-only against production metadata on 2026-10-02:

- **Standard duplicate rules.** `Standard_Lead_Duplicate_Rule` and `Standard_Matching_Rule_for_Leads_on_Accounts` are active on Lead. The workflow does not send `Sforce-Duplicate-Rule-Header`, so a match is returned as `DUPLICATES_DETECTED`; matched Ids are read from `duplicateResult.matchResults[].matchRecords[].record.Id`.
- **DuplicateCheckHandler** (called from the `LeadDuplicateTrigger` before insert/update trigger). It matches on normalized EIN, SSN, cleaned phone and email across Leads, merchant Accounts, Opportunities and Contacts, and blocks with `addError()`. Over the REST API this is `FIELD_CUSTOM_VALIDATION_EXCEPTION` with either "Duplicate <reason> detected. This record matches existing <Object> ... Open here: <org URL>/<Id>" or the "There may be active Opportunities present for this merchant!" warning (which also mentions the Duplicate Check Bypass permission set). Any error message containing "duplicate" (case-insensitive) is classified as `duplicate`; the record Id is taken from the link. The matched record can be a Lead (`00Q`), Account (`001`), Contact (`003`) or Opportunity (`006`); only a Lead Id is returned as `leadId`. Names and owners in the message are not passed back.
- **Allowed with a flag.** The handler lets the insert succeed when the only matches are funded Opportunities, stale Opportunities (which it auto-declines), or when the running user holds the `Bypass_Duplicate_Check` custom permission. In those cases `LeadDuplicateAuditTrigger` attaches a ContentNote titled "Possible Duplicate Detected - <timestamp>" and publishes `Duplicate_Override__e`. No checkbox such as `Is_Duplicate__c` exists on Lead (a numeric `Duplicate_Count__c` does, maintained elsewhere). The workflow reports these as `created`. Make sure the token broker's integration user does **not** hold the bypass permission, or duplicates will be created silently.

In `match_or_create` the email lookup runs first, so a duplicate on email is normally matched and updated instead of rejected. An insert can still be rejected when `DuplicateCheckHandler` matches on phone, EIN or SSN, or matches an Account, Contact or Opportunity; the response is then `duplicate`, as in `create` mode.

### Idempotency

Three layers: the app (`bookings.sf_lead_id` checked before every first-booking send; one job per booking via the unique `(kind, idempotency_key)`, and a reschedule job is keyed by the new booking's id), Redis in n8n (30 days, created, updated and duplicate results), and Salesforce duplicate detection on email. No Lead field holds the booking id today. `External_Lead_ID__c` and `sfleadcaphfprod__External_Lead_ID__c` exist but belong to other integrations and are not reused. **Recommended addition:** a unique, external-id text field `External_Booking_Id__c` on Lead. With it the workflow can add a SOQL lookup before the insert (and the app can map `booking_id` to it).

### Relationship to the Calendly lead flow

The Calendly flow ("Calendly — Lead: Partner ISOs") maps each Calendly event type to an ISO and a mode, matches the invitee's Lead by email and calls the shared writer **Calendly — SF Meeting Booked (shared)** (`yVjvBOx5E3Zc36rX`). This workflow reproduces that for BTC Scheduler pages:

| Calendly | BTC Scheduler |
|---|---|
| Event type mapping `{iso_name, iso_id, mode, write_calendar_event}` | Per page settings: `lead_mode`, ISO (`isoAccountId`), partner display name as `iso_name`; `write_calendar_event` is always `false` |
| Unmapped event types: update only, flagged | Not applicable: only pages with Salesforce on send bookings (`unmapped` is always `false`) |
| Normalize: email lowercased, phone, company, notes question, name split, rep, mobile phone | Done by the app (`lead`, `noteText`, `mobilePhone`, `meeting.host*`); n8n lowercases the email |
| Find Existing Lead (same SOQL and escaping) | **Find Existing Lead** |
| Decide (reschedule means update; open Lead used; converted Lead skipped; create or skip) | **Decide Action** (same rules) |
| Create Lead (rep owner, `Sforce-Auto-Assign: false`) | The original insert path (owner per owner mode) |
| Calls the shared writer | **Write Meeting Booked** (same sub-workflow) |
| `calendly_uri` | `btc-scheduler:<bookingId>` |

The two flows must not act on the same booking. BTC Scheduler bookings never go through Calendly, so they do not overlap. The shared writer's Task node uses the "Salesforce Brian" credential because of a license gap for the integration user; this workflow's own **Create Task** (`create` mode) uses the token broker. If Task inserts fail there with a license error, switch the **Create Task** node to that credential.

### n8n configuration

- Environment variable: `BTC_SCHEDULER_SIGNING_SECRET` (same value as the app's `N8N_SIGNING_SECRET`). The Code nodes use `require('crypto')`, which the token broker already relies on (`NODE_FUNCTION_ALLOW_BUILTIN` must include `crypto`).
- Credentials: Redis "api n8n redis" (`4i3m00SkLAc8SzwE`). Salesforce access comes from the "SF Token Broker" sub-workflow; no Salesforce credential is stored on any node of this workflow.
- **Caller policies.** Both sub-workflows must accept calls from this workflow's owner:
  - SF Token Broker (`7wen5ULQg7DBlCvC`): its caller policy is `workflowsFromSameOwner`, so this workflow must be owned by the same n8n project as the broker.
  - Calendly — SF Meeting Booked (shared) (`yVjvBOx5E3Zc36rX`): in its workflow settings, "This workflow can be called by" must allow this workflow (workflows from the same owner, with this workflow in the same project, or a list of workflow ids that includes this workflow's id after import). Otherwise **Write Meeting Booked** fails and matched Leads come back as a retryable `error`.
- Recommended workflow settings after import: the instance's standard error workflow (the shared writer uses `Q3Ld5IrQCtGimErY`), and consider not saving successful execution data, since payloads contain invitee contact details.

App environment: `N8N_BASE_URL`, `N8N_LEAD_WEBHOOK_PATH`, `N8N_SIGNING_SECRET`, `SF_LEAD_MAX_ATTEMPTS`. Lead modes add no environment variables.

### Import and test

1. In n8n, Workflows, Import from File, select `n8n/sf-lead-create.json`, into the project that owns the SF Token Broker. Confirm the Redis credential bindings (**Idempotency Lookup**, **Remember Result**, **Remember Update**), that **Get SF Token** points at `7wen5ULQg7DBlCvC` and that **Write Meeting Booked** points at `yVjvBOx5E3Zc36rX`.
2. Allow this workflow to call the shared writer (see Caller policies).
3. Set `BTC_SCHEDULER_SIGNING_SECRET` in the n8n environment and restart n8n if required.
4. Test with the webhook's test URL (`/webhook-test/btc-scheduler/lead`) before activating. Sign a body locally:

   ```bash
   SECRET='<shared secret>'
   BODY='{"idempotencyKey":"<uuid>","bookingId":"<uuid>","mode":"create","isReschedule":false,"lead":{"LastName":"Test","Company":"BTC Scheduler Test","Email":"<test address>","Testing__c":true},"owner":{"mode":"fixed","ownerId":"005..."},"autoAssign":false,"meeting":{"startUtc":"2026-10-05T14:00:00Z","endUtc":"2026-10-05T14:30:00Z","eventTypeName":"Test","hostEmail":null,"hostName":null,"isReschedule":false},"options":{"createTask":false,"createNote":false,"setMeetingBookedFields":false},"noteText":null,"sourceLabel":"BTC Scheduler - Test","mobilePhone":null,"isoName":null,"source":"btc-scheduler"}'
   TS=$(date +%s)
   SIG="sha256=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
   curl -sS -X POST "https://api.bigthinkcapital.com/webhook-test/btc-scheduler/lead" \
     -H "Content-Type: application/json" -H "X-BTC-Timestamp: $TS" -H "X-BTC-Signature: $SIG" \
     -H "Idempotency-Key: <uuid>" --data-raw "$BODY"
   ```

   Expected for `create`: `created` with a Lead Id. Sending the same body again returns `existing` with the same Id. A changed body or old timestamp returns 401. A second booking id with the same email returns `duplicate`.
5. Test `match_or_create` with a new booking id, `"mode":"match_or_create"`, the same test email and a real `meeting.hostEmail` (an active Salesforce user): expect `updated` with the test Lead's Id, a "Meeting Booked" note and task on the Lead and a `Lead_Log_Detail__c` row. Repeating the body returns `updated` from Redis without new writes. A new booking id with `"isReschedule":true` adds a "Meeting Booked - Rescheduled" note. With an email that has no Lead, `update_only` returns `skipped` (`no_open_lead`) and `match_or_create` returns `created`.
6. Run the first live tests in a sandbox, or in production only with approval, using `Testing__c = true` and a recognisable test email, then delete the test Leads, their notes, tasks and `Lead_Log_Detail__c` rows, and the Redis keys (`btc-scheduler:lead:<uuid>`).
7. Activate the workflow, then turn on Salesforce for one event type and choose its lead handling.

## Queue snapshot poller

File: `n8n/sf-queue-snapshot-poller.json`. Workflow name: `BTC Scheduler - SF Queue Snapshot Poller`. Target instance: `https://api.bigthinkcapital.com`.

The poller is the source of truth for Salesforce Queue membership. Every 2 minutes it reads the members of every queue linked to a BTC Scheduler team and posts a full snapshot to the app, which diffs it against `team_members` (see PLAN 4.5). A push from Salesforce is optional (see `docs/salesforce-changes.md`).

### Flow

```
Every 2 Minutes ─────────────────────────────┐
Sync Now Webhook → Verify Sync Now Signature │
  → Signature Valid? ── no → Respond 401     │
                    └─ yes → Respond 202 ────┤
                                             ▼
Sign Linked Queues Request → Get Linked Queues → Has Linked Queues? (no: stop)
  → Build Queue Member Query → Get SF Token (SF Token Broker 7wen5ULQg7DBlCvC)
  → Query Queue Members (paginated) → Collect Members → Has Nested Groups?
       ├─ yes → Query Nested Group Members (paginated) ─┐
       └─ no ───────────────────────────────────────────┤
                                                        ▼
                                    Query Users (paginated, execute once)
  → Build Signed Snapshot → Post Snapshot
```

| Node | Purpose |
|---|---|
| Every 2 Minutes | Schedule Trigger, every 2 minutes. |
| Sync Now Webhook | `POST /webhook/btc-scheduler/queue-sync-now`, raw body enabled, responds through a Respond to Webhook node. Called by the app's "Sync now" admin button (`requestSyncNow`). |
| Verify Sync Now Signature | Checks `X-BTC-Timestamp` (5-minute window) and `X-BTC-Signature` (`sha256=` HMAC of `"<timestamp>.<raw body>"`) with `$env.BTC_SCHEDULER_N8N_SIGNING_SECRET`, using a constant-time compare. Invalid requests get 401 and stop. Valid ones get 202 and continue with a normal poll. There is no nonce store here: a replayed request within 5 minutes only causes one extra poll. |
| Sign Linked Queues Request, Get Linked Queues | `GET {BTC_SCHEDULER_BASE_URL}/api/sync/linked-queues`, HMAC-signed over an empty body with `$env.BTC_SCHEDULER_SIGNING_SECRET`. Returns `{ "queueIds": [...] }` for teams whose membership source is not `manual`. |
| Has Linked Queues? | Stops when the list is empty. |
| Get SF Token | Execute Workflow on `SF Token Broker` (`7wen5ULQg7DBlCvC`), no inputs. Later nodes send `Authorization: Bearer {{ $('Get SF Token')... .json.access_token }}`. |
| Query Queue Members | `GET /services/data/v60.0/query?q=SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN (...)`. Pagination follows `nextRecordsUrl` until `done` is true (100 pages maximum). |
| Collect Members | Splits members into users (`005...`) and nested groups (`00G...`), and builds the next two queries. |
| Query Nested Group Members | Runs only when a queue contains a public group. Reads that group's members. One level of nesting is expanded. Members that are themselves groups are skipped and counted in `skippedNested`. Roles, roles-and-subordinates and territories are not expanded. |
| Query Users | `SELECT Id, Email, IsActive FROM User WHERE Id IN (SELECT UserOrGroupId FROM GroupMember WHERE GroupId IN (<queues and nested groups>))`, paginated, executed once. |
| Build Signed Snapshot | Builds `{ snapshotId, takenAt, queues: [{ queueId, members: [{ sfUserId, email, isActive }] }] }`. Every linked queue is present, with `members: []` when it is empty, so the app can apply its empty-queue safety rail. Inactive users are sent with `isActive: false`; the app treats them as removed. Signs the exact body string and uses `snapshotId` as `X-BTC-Nonce`. |
| Post Snapshot | `POST {BTC_SCHEDULER_BASE_URL}/api/sync/queue-snapshot` with the signed raw body. A non-2xx response fails the node, so the workflow's error workflow runs. Not retried, because the nonce may only be used once; the next run 2 minutes later retries naturally. |

Why the extra user query: `GroupMember` has no `User` relationship in SOQL, so `SELECT User.Email, User.IsActive FROM GroupMember` is rejected by Salesforce ("Didn't understand relationship 'User'"). This was verified against the production org on 2026-10-02.

### Environment variables (n8n)

| Variable | Value |
|---|---|
| `BTC_SCHEDULER_BASE_URL` | App origin, for example `https://book.bigthinkcapital.com` (no trailing slash). |
| `BTC_SCHEDULER_SIGNING_SECRET` | Same value as the app's `SF_SYNC_SIGNING_SECRET`. Signs `linked-queues` and `queue-snapshot` requests. |
| `BTC_SCHEDULER_N8N_SIGNING_SECRET` | Same value as the app's `N8N_SIGNING_SECRET`. Verifies "Sync now" requests from the app. |
| `SF_INSTANCE_URL` | Optional. Defaults to `https://bigthink.my.salesforce.com`. |

The Code nodes use `require('crypto')`, which must be allowed (`NODE_FUNCTION_ALLOW_BUILTIN=crypto`, already the case for the token broker's JWT signing).

### App endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/sync/linked-queues` | HMAC over empty body | |
| `POST /api/sync/queue-snapshot` | HMAC + `X-BTC-Nonce` (required, single use) | Body at most 2 MB. Returns `{ ok, snapshotId, teams: [{ teamId, status, reason?, counts?, events, reassignJobs, alertId? }], rejectedQueueIds }`. `status` is `applied`, `blocked` (safety rail), `skipped` or `error`. Returns 422 when none of the queues is linked, 409 on a reused nonce, 401 on a bad or stale signature, and 500 when any team failed (other teams are still applied). |

Responses contain counts only, never emails.

### Import and activate

1. In n8n, Workflows > Import from File, choose `n8n/sf-queue-snapshot-poller.json`.
2. Confirm `Get SF Token` points at `SF Token Broker` (`7wen5ULQg7DBlCvC`).
3. Settings: the error workflow is set to `Q3Ld5IrQCtGimErY` (the error workflow used by the token broker). Change it if a different one should be alerted. Successful executions are not saved, to avoid storing employee emails in execution history.
4. Set the environment variables above and restart n8n if they are read at start-up.
5. Run once manually and check that `Post Snapshot` returns `ok: true`. Then activate.

### Operations

- Staleness: the app's `/api/cron/queue-sync-health` cron (every 10 minutes) marks a queue-driven team `stale` and raises one `sync_stale` alert when no snapshot has arrived for `QUEUE_POLL_STALE_MINUTES` (default 10). The next applied snapshot resolves it.
- Safety rail: when a snapshot would pause more than the team's `mass_removal_threshold_pct` of its active queue members, or a linked queue that previously had members comes back empty, nothing is applied, the team's `sync_health` becomes `blocked`, and a `mass_removal_blocked` alert is raised (updated, not duplicated, on later polls). An admin can resolve the alert with "approve", which lets the next snapshot within 30 minutes apply once.
- Unlinking a queue does not change members immediately. The next snapshot pauses members who were only in that queue, subject to the safety rail.

## Known limitations and follow-ups

- **Lead create timeout race.** The lead workflow writes its Redis idempotency record only after the Lead insert succeeds. If a request takes longer than the app's 20-second timeout, the app retries while the first execution may still be running, and a second Lead can be inserted (Salesforce duplicate rules and `DuplicateCheckHandler` usually catch it). Recommended change at import time: as the first step after signature verification, set an "in-flight" key `btc-scheduler:lead-inflight:<bookingId>` with a short TTL (for example 120 seconds) only if it does not already exist (Redis `SET ... NX EX`, available through the Redis node's custom command or a Code node), and respond `{status: "error", retryable: true}` when it already exists. A booking-ID custom field on Lead (for example `External_Booking_Id__c`, unique, external ID) would also allow a SOQL idempotency check and is recommended.
- **Lead update timeout race.** The same window applies to the update path: **Remember Update** runs after the shared writer returns. If the app times out and retries while the first execution is still in the writer, the Lead can receive a second Meeting Booked note and task. The in-flight key above covers this path too. A shared writer that fails outright is reported as a retryable `error`, and a retry can repeat the writes that had already succeeded.
- **Shared writer contract.** The shared writer's output fields (`ok`, `skipped`, `problems`, `patch_ok`, `note_ok`, `task_ok`, `rep_resolved`) are read as described above. If its contract changes, update **Final Result** and **Build Writer Input** in this workflow.
- **Converted and skipped invitees.** A booking whose invitee only has a converted Lead, or that has no open Lead in update-only mode, is skipped without any Salesforce write; the job result names the converted Lead. Calendly flags unmapped bookings for review; BTC Scheduler has no such queue, so admins review skipped jobs on Admin > Salesforce lead jobs.
- **Queue IDs.** The app normalizes queue IDs to 18 characters when an admin links them. The poller only accepts 18-character IDs.
- **Not yet imported.** Neither workflow has been imported or run on api.bigthinkcapital.com. Confirm the Webhook node's raw-body option and the HTTP Request pagination settings on the live instance during import. Both workflows must live in the same n8n project as the SF Token Broker, which only accepts calls from workflows with the same owner, and the lead workflow must also be allowed to call the shared Meeting Booked writer.
- **Offline tests.** `tests/unit/n8n-sf-lead-workflow.test.ts` checks the node graph and runs the Code nodes of the lead workflow with stand-ins for the n8n globals (decision rules, SOQL escaping, writer input, response contract). It does not replace a test run on the n8n instance.
