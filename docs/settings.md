# Admin > Settings: integration keys

Global admins can set, replace and remove the keys for third-party integrations at **Admin > Settings** (`/admin/settings`), without Vercel access or a redeploy. Bootstrap configuration stays in the Vercel environment.

## How values are resolved

For each managed key the app uses, in order:

1. the value set in Admin > Settings (table `app.integration_settings`),
2. the Vercel environment variable of the same name,
3. nothing (or the built-in default, for `EMAIL_FROM`).

Removing a value in the panel falls back to the Vercel value. Code reads these keys only through `integrationSettings()` in `src/server/settings/integrations.ts`, never through `env()`.

Each server instance caches the panel values for 30 seconds. A change made in the panel applies at once on the instance that handled it and within 30 seconds everywhere else.

Each read is bounded: a 1-second lock timeout, a 2-second statement timeout and a 2.5-second overall deadline that also covers the wait for a database connection. If a read fails or times out, the instance keeps using the values of its last successful read and tries again after 5 seconds. Only an instance that has not read the table yet falls back to the Vercel values. Warnings contain only an error code, never values.

A key counts as unavailable when it may be set in the panel but its value cannot be determined: the instance has not read the table yet, or the stored secret does not decrypt with the current key ring. An unavailable key uses its Vercel value. When Vercel has no value either, the app does not treat the key as deliberately not set:

- Email, text message and Slack jobs fail and are retried (`IntegrationSettingUnavailableError`) instead of finishing without sending.
- Turnstile verification fails closed with `settings_unavailable`, as it does when Cloudflare cannot be reached.
- The webhook and sync endpoints already refuse requests when their secret is missing.

## Managed keys

| Group | Key | Kind |
|---|---|---|
| Email (Resend) | `RESEND_API_KEY` | secret |
| Email (Resend) | `EMAIL_FROM` | plain |
| Text messages (SendBlue) | `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_WEBHOOK_SECRET` | secret |
| Text messages (SendBlue) | `SENDBLUE_FROM_NUMBER` (E.164) | plain |
| Slack | `SLACK_BOT_TOKEN` | secret |
| Slack | `SLACK_ADMIN_NOTIFY_CHANNEL` | plain |
| Bot protection (Turnstile) | `TURNSTILE_SECRET_KEY` | secret |
| Bot protection (Turnstile) | `TURNSTILE_SITE_KEY` | plain |
| Salesforce and n8n | `N8N_SIGNING_SECRET`, `SF_SYNC_SIGNING_SECRET`, `SF_QUEUE_PUSH_BEARER` | secret |

Values are validated with the same rules `src/server/env.ts` applies to the variable (`integrationValueRules`), after trimming. Empty values, values longer than 4096 characters and values with line breaks or other control characters are refused. In production, Cloudflare's Turnstile test keys (site and secret keys that start with `1x`, `2x` or `3x` followed by zeros) are refused as well: they either let every request pass or block every booking.

These stay in Vercel and cannot be changed in the app: `DATABASE_URL`, `TOKEN_ENCRYPTION_KEYS`, `TOKEN_ENCRYPTION_ACTIVE_KID`, `ENTRA_*`, `CRON_SECRET`, `IP_HASH_SALT`, `APP_BASE_URL`, `MCP_BASE_URL`, `ADMIN_EMAILS`, `ALLOWED_EMAIL_DOMAINS`, `N8N_BASE_URL` and `N8N_LEAD_WEBHOOK_PATH`. The n8n URLs are excluded on purpose: the app sends signed payloads to them, so an editable URL would let anyone with admin access redirect those requests. The page lists these variables as Set or Missing, never with their values.

## Storage and access

- Secrets are encrypted with the app key ring (`encryptSecret`, AES-256-GCM) with the encryption context `integration_setting:<KEY>`, so a ciphertext copied to another key's row does not decrypt.
- For secrets of 16 characters or more, the last four characters (`last4`) are stored in clear for display and the audit log. For shorter secrets, `last4` is null and no characters are shown anywhere, because four characters would give away too much of the value. The same rule applies to Vercel values shown on the page.
- `app_user` can read `key`, `is_secret`, `value_plain`, `last4`, `updated_by` and `updated_at`, and can write `value_enc`, but can never read `value_enc`. Row-level security limits every read and write to global admins, and a write must name the acting admin in `updated_by`.
- Decryption happens only in the resolver, on the service connection.
- Check constraints allow only the managed key names and require `value_enc` for secrets and `value_plain` for plain keys.

Migration: `supabase/migrations/20261112120000_integration_settings.sql`.

## The page

Each group shows, per key: the source (**Set here**, **From Vercel**, **Default** or **Not set**), the last four characters of a secret or the full value of a plain key, who changed it and when, a form to set or replace it, and **Remove**. Secret fields are password fields and are cleared after a save. Secrets are never sent back to the browser.

On each page load the server tries to decrypt every saved secret on the service connection and reports only whether it worked. A saved secret that does not decrypt (for example after a key id was removed from `TOKEN_ENCRYPTION_KEYS`) is marked **Unreadable**, with the value the app uses instead (the Vercel value, or none). Set it again to fix it. **Not loaded** means the settings could not be read on that server just now.

Test buttons reach only the signed-in admin, or no one:

| Group | Test | What it does |
|---|---|---|
| Email | Send test email | Sends one email to the admin's own address. |
| Text messages | Send test text | The SendBlue client has no read-only request, so this sends one text to the admin's own mobile number (Availability > Booking preferences). A number that replied STOP is not texted. |
| Slack | Check token | Calls `auth.test`. Nothing is posted. |
| Turnstile | Check secret key | Calls `siteverify` with the secret and a dummy token. `invalid-input-secret` means the secret is wrong; `invalid-input-response` means the secret is valid. A secret that accepts the dummy token is a Cloudflare test key that lets every request pass, so the check fails. |

Set both Turnstile keys or neither. With only the secret, public forms cannot pass the check; with only the site key, the check is shown but not verified. The page warns when only one is in use, counting an unreadable secret as not set.

## Audit

Every change is written in the same transaction as the change, with entity type `integration_setting` and the key as entity id:

- `settings.update`: set or replace. `before` and `after` are `{ key, source, last4 }`.
- `settings.remove`: remove. `after` shows the source that applies now.
- `settings.test`: a test button was used. `after` is `{ service, ok }`.

`last4` is null for plain keys and for secrets shorter than 16 characters. Values are never written to the audit log.

## Rotating a key

1. Create the new key with the provider.
2. Set it in Admin > Settings and use the test button where there is one. Other server instances keep using the old value for up to 30 seconds.
3. For shared secrets (`N8N_SIGNING_SECRET`, `SF_SYNC_SIGNING_SECRET`, `SF_QUEUE_PUSH_BEARER`, `SENDBLUE_WEBHOOK_SECRET`), update the other side (n8n, Salesforce or SendBlue) right after. Requests signed with the old value fail until both sides match, including on instances that still hold the old value.
4. Wait at least 30 seconds, then revoke the old key with the provider. If the old value is also in Vercel, remove or replace it there too: the app falls back to the Vercel value when the panel value is removed or cannot be read.

### Turnstile keys

The site key and the secret key belong to one Cloudflare widget and must match. Each is saved on its own, and every instance picks up a change within 30 seconds, so the order matters:

- **New secret for the same widget.** Only the secret changes. Save it, run the test button, and keep the old secret valid at Cloudflare for at least a minute if Cloudflare offers that. If the old secret stops working at once, verifications on instances that still hold it fail for up to 30 seconds.
- **Switch to a different widget.** Saving one key before the other makes public bookings, reschedules and cancellations fail with `verification_failed` until both match everywhere. To switch without failures (assuming Vercel has no Turnstile keys; otherwise removing the panel value falls back to the Vercel secret):
  1. Remove `TURNSTILE_SECRET_KEY` and wait 30 seconds. Verification is now skipped everywhere.
  2. Replace `TURNSTILE_SITE_KEY` with the new widget's site key and wait 30 seconds. Every public page now shows the new widget.
  3. Set `TURNSTILE_SECRET_KEY` to the new widget's secret key and run the test button. Verification is on again within 30 seconds.

  Bot protection is off for about a minute. Alternatively, save both keys back to back at a quiet time and expect up to 30 seconds of failed verifications.

## Code

- `src/server/settings/keys.ts`: key list, groups, validation, bootstrap list.
- `src/server/settings/integrations.ts`: resolver, cache, `turnstileSiteKey()` (the only setting public pages read).
- `src/server/settings/admin.ts`: list, set and remove (RLS, admin check, audit).
- `src/server/settings/checks.ts`: test buttons.
- `src/app/(app)/admin/(admin-only)/settings/page.tsx` and `src/app/(app)/admin/_actions/settings.ts`: page and server actions.
- Tests: `tests/unit/integration-settings.test.ts`, `tests/integration/integration-settings.test.ts`.
