# Partner page branding

Partners (ISOs) are teams. Each team's public booking pages (`/t/{team}`, `/t/{team}/{event}`, its Spanish variants, and the `/b/{token}` confirmation page for its bookings) can carry the partner's own name, logo, accent color and wording. Individual (non-team) pages are not affected.

## Who can change it

Global admins and the team's own team admins. Open the team (**Teams > {team}**) and choose **Branding**, or go to `/teams/{id}/branding`. Other users, managers and admins of other teams see a "Team admins only" notice. Every save, logo upload, replacement and removal is written to the audit log (`team.page_settings_update`, `team.logo_upload`, `team.logo_replace`, `team.logo_remove`); settings entries record only the fields that changed.

## Settings

Stored in `app.teams.page_settings` (JSON) and validated by `src/server/teams/page-settings.ts`. Unknown keys are rejected.

| Setting | Type | Default | Effect |
|---|---|---|---|
| `displayName` | text, up to 80 characters, one line | team name | Partner name in the page header, page title and event page label. |
| `accentColor` | hex color `#RRGGBB` | BTC blue | Buttons, links, focus rings and card accents. Colors with less than 4.5:1 contrast against white fall back to BTC blue (WCAG AA). The form shows a warning when that happens. |
| `heading` | text, up to 120 characters, one line | display name | Title of the event list and the label above each event name. |
| `intro` | plain text, up to 1,000 characters | team description | Paragraph under the heading and at the end of each booking page's details. |
| `showPartnerLogo` | on/off | on | Partner logo in the header (when one is uploaded). |
| `showBtcLogo` | on/off | on | Big Think Capital logo in the header next to the partner name. |
| `showHostPhoto` | on/off | on | Host photos on the booking confirmation page. |
| `showHostName` | on/off | on | Host names on the confirmation page and in its calendar links. With names hidden, photos have generic alt text and no initials are shown. |
| `showDuration` | on/off | on | Meeting length on the event list and booking page details. The duration picker still appears when an event offers several lengths. |
| `showDescription` | on/off | on | Event descriptions on the event list and booking page. |

## Logo

- PNG, JPEG or WebP only, up to 512 KB and 4096 pixels per side. SVG is never accepted.
- The format is detected from the file's leading bytes; a declared type that does not match is rejected.
- Stored in `app.team_logos` (one row per team) with its SHA-256 hash and dimensions. Signed-in users can read the metadata of teams they administer (managers can read all), never the bytes.
- Served at `GET /api/public/team-logo/{teamId}` with the stored `Content-Type`, `X-Content-Type-Options: nosniff`, a `default-src 'none'; sandbox` Content Security Policy and an `ETag` of the hash. Page links include `?v=<hash prefix>`, which makes the response cacheable for a year; a new upload changes the link.

## For developers

- `getPartnerBranding(teamId)` in `src/server/teams/branding.ts` returns the public-safe branding (`displayName`, `logoUrl`, `accentColor`, `heading`, `intro` and the `show*` flags) with defaults applied and the accent already contrast-checked. Use it for notifications and any other partner-facing output. `getPartnerBrandingForEventType()` and `getPartnerBrandingForManageToken()` return the same for an event type or booking, or null for individual pages.
- Display rules for public pages are pure functions in `src/components/public/branding.ts` and are unit-tested.
- Team admins may update `page_settings` because `app.guard_team_admin_columns()` restricts only sync, safety-rail and slug columns; the `teams_update` policy limits writes to the team's admins.
