# REST API and MCP server

BTC Scheduler exposes the same capabilities two ways:

- **MCP server** for AI assistants (Claude and other Model Context Protocol clients), at `https://mcp.bigthinkcapital.com/mcp`. Until that domain is configured, use `<APP_BASE_URL>/mcp`.
- **REST API** for scripts and automations, at `<APP_BASE_URL>/api/v1`. The description is at `/api/v1/openapi.json`.

Both act as the signed-in user, with that user's current role and permissions. Both use the service layer in `src/server/api/services/`, under row-level security. Every change is recorded in the audit log with its channel (`api` or `mcp`).

## Roles

| Role | Bookings | Booking pages | Users | Audit log |
|---|---|---|---|---|
| Agent (`user`) | Own bookings only | Own pages and pages of teams they belong to; create and edit their own | Directory | No |
| Manager (`manager`) | All (read) | All (read); create and edit their own | Directory | Read |
| Admin (`admin`) | All | All | Add users, change roles, deactivate | Read |

Team admins also manage their teams' members and pages. The matrix lives in `src/lib/permissions.ts`.

## MCP server

### Connecting

- **Claude** (claude.ai or the desktop app): Settings > Connectors > Add custom connector, then paste the server URL. Sign in with Microsoft and approve the connection.
- **Claude Code**: `claude mcp add --transport http btc-scheduler https://mcp.bigthinkcapital.com/mcp`

Each user sees and disconnects their connected apps under **Settings > Integrations**.

### Authorization

The app is an OAuth 2.1 authorization server, following the MCP authorization specification.

| Endpoint | URL |
|---|---|
| Protected resource metadata (RFC 9728) | `<MCP origin>/.well-known/oauth-protected-resource` |
| Authorization server metadata (RFC 8414) | `<APP_BASE_URL>/.well-known/oauth-authorization-server` |
| Dynamic client registration (RFC 7591) | `<APP_BASE_URL>/api/oauth/register` |
| Authorization (consent screen) | `<APP_BASE_URL>/oauth/authorize` |
| Token | `<APP_BASE_URL>/api/oauth/token` |
| Revocation (RFC 7009) | `<APP_BASE_URL>/api/oauth/revoke` |

- **Clients.** Public clients only. PKCE (S256) is required.
- **Callback URLs.** Clients register themselves, but only with callback (redirect) URLs on the allowlist in **Admin > Integrations**. The defaults are Claude's callback URLs and loopback URLs for local clients (`http://localhost:*/callback`). An admin can also register a client by hand.
- **Tokens.** Access tokens last one hour and are bound to the MCP resource (RFC 8707). Refresh tokens last 30 days and rotate on every use; presenting a rotated refresh token revokes the whole connection. Only SHA-256 hashes of tokens are stored.
- **Access changes.** Deactivating a user revokes all their tokens. Disabling a client revokes its connections.

### Transport

Streamable HTTP, stateless and JSON-only. `POST /mcp` takes JSON-RPC requests (or batches) and answers with JSON. `GET /mcp` and `DELETE /mcp` return 405, because the server never streams. The supported protocol versions are 2025-11-25, 2025-06-18 and 2025-03-26.

### Tools

| Tool | What it does | Role |
|---|---|---|
| `whoami` | The user, role, capabilities and teams | All |
| `list_bookings`, `get_booking` | Bookings the user may see, with answers and history | All |
| `find_available_times` | Open slots on a booking page | All |
| `schedule_meeting` | Book a meeting (Outlook event and invitee email, as on the public page) | All |
| `cancel_booking`, `reschedule_booking` | As host, page owner, team admin or admin | All (RLS decides) |
| `list_booking_pages`, `get_booking_page` | Booking pages with public URLs | All |
| `create_booking_page`, `update_booking_page`, `delete_booking_page` | Manage pages | All (RLS decides) |
| `add_question`, `update_question`, `remove_question`, `set_questions` | Booking form questions | All (RLS decides) |
| `list_teams`, `get_team`, `add_team_member`, `remove_team_member` | Teams | All (team admins and admins can change) |
| `list_users` | User directory | All |
| `create_user`, `update_user` | Add users, change roles and active state | Admin |
| `list_audit_log` | Search the audit log | Manager, Admin |

Tools a role may not use are not listed, and they are refused if called.

### mcp.bigthinkcapital.com

1. In Vercel, add the domain `mcp.bigthinkcapital.com` to the project.
2. In DNS, add a CNAME record from `mcp` to the target Vercel shows.
3. Set `MCP_BASE_URL=https://mcp.bigthinkcapital.com` in Vercel and redeploy.

The MCP endpoint then answers at `https://mcp.bigthinkcapital.com/mcp`. Opening the bare domain in a browser redirects to Settings > Integrations.

## REST API

Create an API key under **Settings > Integrations** and send it as `Authorization: Bearer btc_pat_...`.

- **Behavior.** Keys are shown once, can expire, and act with the owner's current role. Each key is limited to 120 requests per minute.
- **Responses.** Results are wrapped in `{ "data": ... }`. Errors are `{ "error": { "code", "message", "details? } }` with the matching HTTP status.

| Method and path | Purpose |
|---|---|
| `GET /me` | User, role and capabilities |
| `GET /bookings`, `POST /bookings` | List bookings; schedule a meeting |
| `GET /bookings/{id}` | Booking with answers and history |
| `POST /bookings/{id}/cancel`, `POST /bookings/{id}/reschedule` | Cancel; move to a new time |
| `GET /event-types`, `POST /event-types` | List; create a booking page |
| `GET`, `PATCH`, `DELETE /event-types/{id}` | Read, change or delete a booking page |
| `GET /event-types/{id}/slots` | Open times |
| `GET`, `POST`, `PUT /event-types/{id}/questions` | List, add, or replace questions |
| `PATCH`, `DELETE /event-types/{id}/questions/{key}` | Change or remove a question |
| `GET /teams`, `GET /teams/{id}` | Teams and members |
| `POST /teams/{id}/members`, `DELETE /teams/{id}/members/{memberId}` | Add or remove a member |
| `GET /users`, `POST /users`, `PATCH /users/{id}` | Directory; add a user (admin); change a user (admin) |
| `GET /audit` | Audit log (manager, admin) |
| `POST /import/calendly?apply=true` | Run the Calendly import from a snapshot body, up to 4 MB (admin). Dry run unless `apply=true`; a refused run returns 409. |

Example: schedule a meeting.

```bash
curl -X POST "$APP_BASE_URL/api/v1/bookings" \
  -H "Authorization: Bearer $BTC_API_KEY" -H "Content-Type: application/json" \
  -d '{"eventTypeId":"<id>","start":"2026-11-03T15:00:00Z","invitee":{"name":"Pat","email":"pat@example.com","timezone":"America/New_York"}}'
```

## Request log and limits

- **Rate limits:** 120 requests per minute per API key on the REST API, and 240 per minute per token on the MCP server. Over the limit, the response is 429 with `Retry-After`.
- **Request log:** every authenticated request is written to `app.api_request_log` after the response is sent. Each entry records the user, the API key or OAuth app, the method, the route with identifiers replaced by `:id`, the JSON-RPC methods (for example `tools/call list_bookings`), the status and the duration. Request and response bodies, query strings and headers are never stored, and the client IP is stored only as a salted hash. Entries are deleted after 30 days.
- **Who sees it:** users see their own last 25 requests on **Settings > Integrations**; admins see the last 100 from everyone on **Admin > Integrations**.
- **Errors:** unexpected failures are also recorded in the error log (**Admin > Errors**).

## Code layout

```
src/lib/permissions.ts          roles and capabilities
src/server/oauth/               authorization server, tokens, metadata
src/server/api/context.ts       Caller, ApiError, asCaller (RLS and audit channel)
src/server/api/services/        bookings, booking pages and questions, teams, users, audit
src/server/api/http.ts          REST plumbing (API keys, rate limits, errors)
src/server/api/request-log.ts   request log for the REST API and MCP server
src/server/mcp/                 MCP protocol handler and tools
src/app/api/v1/                 REST routes
src/app/api/mcp/route.ts        MCP endpoint (also at /mcp)
src/app/oauth/authorize/        consent screen
src/app/.well-known/            OAuth discovery documents
```
