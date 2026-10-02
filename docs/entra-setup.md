# Microsoft Entra ID app registration

BTC Scheduler signs employees in with Microsoft 365 and uses the same sign-in to read and write their Outlook calendars. One app registration covers local, preview and production.

Tenant: Big Think Capital (`91e22286-3995-43b2-9197-481a21962994`).

## 1. Create the registration

1. Go to the Microsoft Entra admin center: **Identity > Applications > App registrations > New registration**.
2. Name: `BTC Scheduler`.
3. Supported account types: **Accounts in this organizational directory only (Big Think Capital only - Single tenant)**.
4. Redirect URI: platform **Web**, value `http://localhost:3000/api/auth/callback`. More URIs are added in step 2.
5. Select **Register**. Copy the **Application (client) ID** into `ENTRA_CLIENT_ID`.

## 2. Redirect URIs

Go to **Authentication > Platform configurations > Web** and add one URI for each environment:

| Environment | Redirect URI |
|---|---|
| Local | `http://localhost:3000/api/auth/callback` |
| Preview | `https://<stable-preview-alias>/api/auth/callback` |
| Production | `https://<production-domain>/api/auth/callback` (for example `https://book.bigthinkcapital.com/api/auth/callback`) |

Notes:

- Entra does not accept wildcard redirect URIs, so a per-commit Vercel preview URL cannot sign in. Give the preview environment a stable alias: either a branch domain in Vercel (Project > Settings > Domains, assign a domain to the `preview` branch) or the automatic branch URL `https://<project>-git-<branch>-<team>.vercel.app`. Register that alias here and set `APP_BASE_URL` to it in the Preview environment.
- Until the custom domain is set up, use the production `*.vercel.app` URL and add the custom domain URI later.
- Leave **Front-channel logout URL** empty. Leave **Implicit grant and hybrid flows** unchecked (the app uses the authorization code flow with PKCE).
- **Allow public client flows**: No.

## 3. Client secret

1. Go to **Certificates & secrets > Client secrets > New client secret**.
2. Description `btc-scheduler-<environment>`, expiry 12 or 24 months.
3. Copy the secret **Value** (not the Secret ID) into `ENTRA_CLIENT_SECRET` in Vercel.
4. Put a calendar reminder about 30 days before expiry. When the secret expires, nobody can sign in and calendar sync stops for everyone. To rotate, create a second secret, update Vercel, redeploy, then delete the old secret.

A certificate credential is also supported by Entra and is stronger than a secret, but it needs extra signing code in the app. The secret is used for v1.

## 4. API permissions

Go to **API permissions > Add a permission > Microsoft Graph > Delegated permissions** and add:

| Permission | Why |
|---|---|
| `openid`, `profile`, `email` | Sign-in identity |
| `offline_access` | Refresh token, so calendar sync keeps working when the user is offline |
| `User.Read` | Name, email, mailbox time zone |
| `Calendars.ReadWrite` | Read busy time, create/update/delete booking events, change notifications |
| `OnlineMeetings.ReadWrite` | Requested for Teams meetings. Teams links on calendar events also work with `Calendars.ReadWrite` alone, so this can be removed later. |

### Admin consent

Microsoft's permissions reference lists these delegated permissions as not requiring admin consent, so each user could consent at first sign-in. Whether users are allowed to consent depends on BTC's tenant settings (**Enterprise applications > Consent and permissions > User consent settings**). Many tenants block user consent for apps that are not from verified publishers.

Recommended: a Global Administrator or Privileged Role Administrator selects **Grant admin consent for Big Think Capital** on the API permissions page. This avoids a consent prompt for every employee and avoids sign-in failures caused by consent policy. The app treats a revoked grant as a broken calendar connection and shows a "Reconnect Outlook" banner.

## 5. Token configuration (optional)

Under **Token configuration > Add optional claim > ID**, add `email`. The app falls back to `preferred_username` when `email` is absent, so this is optional.

## 6. Restrict who can sign in (optional)

The app already rejects any account outside `ALLOWED_EMAIL_DOMAINS`. To restrict further, go to **Enterprise applications > BTC Scheduler > Properties**, set **Assignment required** to Yes, then assign a group under **Users and groups**.

## 7. Environment variables

| Variable | Value |
|---|---|
| `ENTRA_TENANT_ID` | `91e22286-3995-43b2-9197-481a21962994` |
| `ENTRA_CLIENT_ID` | Application (client) ID |
| `ENTRA_CLIENT_SECRET` | Client secret value |
| `APP_BASE_URL` | The base URL whose `/api/auth/callback` is registered for that environment |

## 8. Verify

1. Run the app locally (`pnpm dev`) and open `http://localhost:3000/login`.
2. Sign in with a BTC account. You should land on `/dashboard`, and a row should exist in `app.users` and `app.calendar_connections` (status `healthy`).
3. To test revoked consent, go to **My Apps > BTC Scheduler > Revoke permissions** (or remove the grant in Enterprise applications), wait for the access token to expire (up to one hour), and load the dashboard. The "Reconnect Outlook" banner should appear.
