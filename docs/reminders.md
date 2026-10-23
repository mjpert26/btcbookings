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

## What is sent

| Audience | Channel | Content | Language |
|---|---|---|---|
| Merchant | Email | Existing reminder email, plus the partner name on team pages | Booking language (English or Spanish) |
| Merchant | SMS | Meeting name, date and time in the merchant's time zone, partner name, Teams link, reschedule or cancel link, "Reply STOP to opt out" | Booking language |
| Agent | Email | Meeting time in the agent's time zone, partner, merchant name, email and phone, the merchant's answers, meeting link, booking link | English |
| Agent | Slack | The same details as a direct message from the BTC Scheduler Slack app | English |
| Agent | SMS | Meeting, merchant, partner, time, phone, meeting link, booking link | English |

Agent reminders go to every active host of the booking (one per host for collective pages). Merchant texts go to the phone number entered on the booking form. Agent texts go to `app.user_settings.sms_phone` (E.164). There is no screen to set `sms_phone` yet; until there is, an admin sets it in the database, and hosts without a number are skipped.

## Scheduling and cancellation

Reminder jobs are created in the same transaction as the booking (`src/server/booking/side-effects.ts`), one job per booking, channel, recipient and offset:

| Job kind | Idempotency key |
|---|---|
| `email_send` (merchant) | `<bookingId>:reminder:<offset>` |
| `email_send` (agent, template `host_booking_reminder`) | `<bookingId>:host_reminder:<userId>:<offset>` |
| `sms_send` (merchant) | `<bookingId>:sms:invitee:<offset>` |
| `sms_send` (agent) | `<bookingId>:sms:<userId>:<offset>` |
| `slack_dm_send` | `<bookingId>:slack_dm:<userId>:<offset>` |

- Offsets whose send time has already passed are skipped.
- Cancelling (by the merchant or a host) marks every pending reminder job for the booking as dead. Rescheduling does the same for the old booking and creates new reminders for the new booking.
- Reassigning a round-robin booking to another host moves the agent reminders to the new host. Removing a host from a collective booking cancels that host's reminders.
- Every handler reloads the booking before sending and skips cancelled bookings, meetings that already started, starts that moved later, and hosts that are no longer assigned.
- Imported (Calendly) bookings never produce reminder jobs: every job carries `payload.bookingId`, and the `jobs_skip_imported_bookings` trigger drops it.

The main worker (`/api/cron/jobs`) sends reminders. `/api/cron/reminders` drains only the reminder job kinds as a safety net.

## SendBlue setup

1. In the SendBlue dashboard, create an API key. Set `SENDBLUE_API_KEY` (key ID) and `SENDBLUE_API_SECRET` (secret key) in Vercel.
2. Optional: set `SENDBLUE_FROM_NUMBER` to the sending line in E.164. It is required on shared-line plans.
3. Add a receive webhook that points to `<APP_BASE_URL>/api/sms/inbound` and give it a signing secret of at least 16 characters. Set the same value as `SENDBLUE_WEBHOOK_SECRET`. SendBlue sends it in the `sb-signing-secret` header; requests without a matching header get HTTP 401, and the route returns 503 until the secret is configured.

Without the key and secret, text jobs complete with a "not sent" log line and nothing is sent, the same way email works without `RESEND_API_KEY`.

The client (`src/server/sms/sendblue.ts`) calls `POST https://api.sendblue.com/api/send-message` with the `sb-api-key-id` and `sb-api-secret-key` headers. Rate limits (HTTP 429 and line capacity declines) are retried later; validation errors, blacklisted numbers and `ERROR` or `DECLINED` statuses fail the job without retrying. SendBlue has no idempotency key, so a send that times out after SendBlue accepted it can be delivered twice when the job retries.

## Phone numbers and opt-outs

- Numbers are normalized to E.164 before sending. Numbers without a country code are treated as US numbers. Invalid numbers are skipped (`invalid_phone`).
- A reply of exactly STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, ALTO or PARAR adds the number to `app.sms_opt_outs`. START, UNSTOP, SUBSCRIBE or OPTIN removes it. A webhook payload with `opted_out: true` is also recorded. Other replies are ignored.
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
