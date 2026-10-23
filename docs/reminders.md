# Reminders, SMS and partner names

This page covers booking reminders for merchants (invitees) and agents (hosts), text messages through SendBlue, SMS opt-outs, and the partner name shown in notifications.

## Booking page settings

Each booking page has a **Reminders** section in the editor (`/event-types/<id>`).

| Setting | Column on `app.event_types` | Choices | Default |
|---|---|---|---|
| Merchant reminders | `merchant_reminder_channels` | Email, Text message (SMS) | Email |
| Merchant reminder times | `reminder_offsets_min` | 1 week, 2 days, 1 day, 4 hours, 2 hours, 1 hour, 30 minutes, 15 minutes before | 1 day and 1 hour before |
| Agent reminders | `agent_reminder_channels` | Email, Slack direct message, Text message (SMS) | None |
| Agent reminder times | `agent_reminder_offsets_min` | 5, 15, 30, 60 minutes, 1 day before | 15 minutes before |

The defaults match the behaviour before agent and SMS reminders existed: merchants get email reminders at the configured times and nothing else is sent until a channel is turned on.

Reminder settings belong to each booking page row, like `reminder_offsets_min` always has; they are not an inheritable variant group. A Spanish variant copies the English page's reminder settings when it is created and can be changed on its own afterwards.

Changes to reminder settings are recorded in the audit log as `event_type.update_reminders`, with only the fields that changed.

Changes also apply to bookings that already exist. Reminder jobs are created when the booking is made, but every handler reloads the booking's event type settings before sending and skips the job when its channel is no longer enabled (`channel_disabled`) or its time is no longer selected (`offset_disabled`). Turning a channel or time on does not add reminders to existing bookings; only new bookings get them.

## What is sent

| Audience | Channel | Content | Language |
|---|---|---|---|
| Merchant | Email | Existing reminder email, plus the partner name on team pages | Booking language (English or Spanish) |
| Merchant | SMS | Meeting name, date and time in the merchant's time zone, partner name, Teams link, reschedule or cancel link, "Reply STOP to opt out" | Booking language |
| Agent | Email | Meeting time in the agent's time zone, partner, merchant name, email and phone, the merchant's answers, meeting link, booking link | English |
| Agent | Slack | The same details as a direct message from the BTC Scheduler Slack app | English |
| Agent | SMS | Meeting, merchant, partner, time, phone, meeting link, booking link | English |

Agent reminders go to every active host of the booking (one per host for collective pages). Merchant texts go to the phone number entered on the booking form, and only with consent (see below). Agent texts go to `app.user_settings.sms_phone` (E.164). Each agent sets it under **Availability > Booking preferences**, in the **Mobile number for text reminders** field; the number is normalized to E.164 when saved and the change is recorded in the audit log with the number masked. Hosts without a number are skipped.

## Merchant consent for text messages

On a page whose merchant reminders include text messages, the public booking form shows an unchecked checkbox under the phone field ("Send me text message reminders about this meeting at this number.") with a disclosure: consent is optional and not required to book, texts are automated reminders for this meeting, message and data rates may apply, and replying STOP opts out. Both are shown in English and Spanish.

- Checking the box and entering a phone number stores the time in `app.bookings.sms_consent_at`. Without a phone number nothing is stored.
- A reschedule copies `sms_consent_at` to the new booking.
- Bookings made through the REST API or the MCP `schedule_meeting` tool record consent only when the caller sends `invitee.smsConsent: true`, which it must do only when the invitee agreed.
- The merchant `sms_send` job skips bookings without consent (`no_consent`). Bookings made before consent was recorded, including all imported bookings, have no consent and get no merchant texts.

## Scheduling and cancellation

Reminder jobs are created in the same transaction as the booking (`src/server/booking/side-effects.ts`), one job per booking, channel, recipient and offset:

| Job kind | Idempotency key |
|---|---|
| `email_send` (merchant) | `<bookingId>:reminder:<offset>` |
| `email_send` (agent, template `host_booking_reminder`) | `<bookingId>:host_reminder:<userId>:<offset>` |
| `sms_send` (merchant) | `<bookingId>:sms:invitee:<offset>` |
| `sms_send` (agent) | `<bookingId>:sms:<userId>:<offset>` |
| `slack_dm_send` | `<bookingId>:slack_dm:<userId>:<offset>` |

Agent reminder keys do not include an assignment counter. When a host is removed from a booking, their pending reminders are marked dead with `last_error = 'host removed'`. If the same host is assigned to the booking again (for example a round-robin booking reassigned A to B and back to A), those rows are reset to pending with the new send time instead of being inserted again. Rows that are dead for any other reason (a cancelled booking, `booking cancelled`, or failed sends) are never revived.

- Offsets whose send time has already passed are skipped.
- Cancelling (by the merchant or a host) marks every pending reminder job for the booking as dead. Rescheduling does the same for the old booking and creates new reminders for the new booking.
- Reassigning a round-robin booking to another host moves the agent reminders to the new host. Removing a host from a collective booking cancels that host's reminders.
- An Outlook change that cancels the booking (conflict policy `auto_cancel`) also cancels its pending reminders.
- Every handler reloads the booking before sending and skips cancelled bookings, meetings that already started, starts that moved later (`start_moved`), hosts that are no longer assigned, and channels or times that were turned off.
- A reminder that runs late is dropped as `stale` once it is more than half its offset, or 10 minutes if that is longer, past its send time: 12 hours for a 1 day reminder, 30 minutes for a 1 hour reminder. A backlog or a long retry therefore does not deliver several reminders at once or a "1 day" reminder minutes before the meeting.
- Agent email and Slack reminders state the time actually left ("starts in 35 minutes") when they run more than 10 minutes late.
- Imported (Calendly) bookings never produce reminder jobs: every job carries `payload.bookingId`, and the `jobs_skip_imported_bookings` trigger drops it.

The main worker (`/api/cron/jobs`) sends reminders. `/api/cron/reminders` is a safety net that drains every `email_send`, `sms_send` and `slack_dm_send` job, so it also sends confirmation, reschedule, cancellation and host notice emails that are due.

## SendBlue setup

1. In the SendBlue dashboard, create an API key. Set `SENDBLUE_API_KEY` (key ID) and `SENDBLUE_API_SECRET` (secret key) in Vercel.
2. Optional: set `SENDBLUE_FROM_NUMBER` to the sending line in E.164. It is required on shared-line plans.
3. Add a receive webhook that points to `<APP_BASE_URL>/api/sms/inbound` and give it a signing secret of at least 16 characters. Set the same value as `SENDBLUE_WEBHOOK_SECRET`. SendBlue sends it in the `sb-signing-secret` header; requests without a matching header get HTTP 401, and the route returns 503 until the secret is configured.

Without the key and secret, text jobs complete with a "not sent" log line and nothing is sent, the same way email works without `RESEND_API_KEY`.

The client (`src/server/sms/sendblue.ts`) calls `POST https://api.sendblue.com/api/send-message` with the `sb-api-key-id` and `sb-api-secret-key` headers. Each request times out after 15 seconds (Slack Web API calls use the same limit), so a stalled request fails and is retried with backoff instead of the 60 second function being stopped while the job is running. Rate limits (HTTP 429 and line capacity declines) are retried later; validation errors, blacklisted numbers and `ERROR` or `DECLINED` statuses fail the job without retrying. SendBlue has no idempotency key, so a send that times out after SendBlue accepted it can be delivered twice when the job retries.

## Phone numbers and opt-outs

- Numbers are normalized to E.164 before sending. Numbers without a country code are treated as US numbers. Invalid numbers are skipped (`invalid_phone`).
- Stop keywords are STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT (or OPTOUT), and the Spanish ALTO, PARAR, BAJA, CANCELAR and DETENER. Case, accents and punctuation are ignored. A reply adds the number to `app.sms_opt_outs` when:
  - it is only a stop keyword (`STOP`, `Opt-out`, `stop all`),
  - it contains STOP, STOPALL, UNSUBSCRIBE, REVOKE or OPT OUT as a whole word (`Please stop texting me`), or
  - it has at most 6 words and its first or last word is a stop keyword (`cancel please`, `dar de baja`).

  This follows the FCC revocation rule (47 CFR 64.1200(a)(10)) and errs towards opting out: a reply such as `Please stop by at 3` also opts out, and the merchant can reply START to receive texts again.
- A reply of exactly START, UNSTOP, SUBSCRIBE or OPTIN removes the number. A webhook payload with `opted_out: true` is also recorded. Other replies are ignored.
- No text is sent to a number on the opt-out list, for merchants or agents.
- Admins can read the opt-out list; only the service role writes it.
- Message text and full phone numbers are never logged. Job logs show a redacted number such as `+1******0142`.

## Slack direct messages

Agent Slack reminders use the existing bot token (`SLACK_BOT_TOKEN`) and the `chat:write` and `users:read.email` scopes. The host's Slack user is found by email and cached in `app.slack_identities`. The manifest enables the app's read-only Messages tab, which is where the reminders appear. Without a bot token, Slack reminder jobs complete as skipped. Hosts without a Slack account are skipped.

## Partner name

For booking pages that belong to a team (a partner or ISO), the partner name appears in:

- merchant confirmation, reschedule, cancellation and reminder emails (a "Partner" row; "Socio comercial" in Spanish) and the calendar file description,
- merchant and agent text messages,
- agent reminder emails and Slack messages,
- the Outlook event subject (`<page name> (<partner>): <merchant>`) and body.

The name comes from `partnerDisplayName()` in `src/server/email/partner.ts`, which returns the team name. It accepts an optional configured display name, which takes precedence when it is not empty. Individual (non-team) pages show no partner.
