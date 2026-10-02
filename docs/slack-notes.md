# Slack Web API notes

Facts the Slack sync module relies on, checked against Slack's documentation on 2026-10-02.
Re-check these when upgrading or when Slack announces API changes.

## Methods

| Method | Bot scopes | Rate tier | Body sent by the client | Source |
|---|---|---|---|---|
| `conversations.invite` | `channels:manage` (public), `groups:write` (private) | Tier 3 (50+/min) | JSON | https://docs.slack.dev/reference/methods/conversations.invite |
| `conversations.kick` | `channels:manage`, `groups:write` | Tier 3 | JSON | https://docs.slack.dev/reference/methods/conversations.kick |
| `conversations.join` | `channels:join` | Tier 3 | JSON | https://docs.slack.dev/reference/methods/conversations.join |
| `conversations.info` | `channels:read`, `groups:read` | Tier 3 | form | https://docs.slack.dev/reference/methods/conversations.info |
| `conversations.members` | `channels:read`, `groups:read` | Tier 4 (100+/min) | form | https://docs.slack.dev/reference/methods/conversations.members |
| `users.lookupByEmail` | `users:read.email` | Tier 3 | form | https://docs.slack.dev/reference/methods/users.lookupByEmail |
| `chat.postMessage` | `chat:write` | Special: about 1 message per second per channel, plus a workspace limit | JSON | https://docs.slack.dev/reference/methods/chat.postMessage |

All seven method pages list both `application/x-www-form-urlencoded` and `application/json`.
The Web API overview (https://docs.slack.dev/apis/web-api/) says most write methods accept
JSON, that a JSON request must carry the token as `Authorization: Bearer`, and that arguments
must not be mixed between query string, form body and JSON. The client therefore always sends
the token in the header, uses JSON for write methods, and uses form bodies for read methods.

Responses are JSON objects with `ok: true|false` and, on failure, an `error` code.

## Error codes the sync maps

| Method | Code | Slack's description | Our handling |
|---|---|---|---|
| invite | `already_in_channel` | Invited user is already in the channel. | Success (idempotent). |
| invite | `not_in_channel` | Authenticated user is not in the channel. | Call `conversations.info`. Public: `conversations.join`, then retry once. Private: health `bot_not_in_channel`. |
| invite | `channel_not_found` | Value passed for `channel` was invalid. | Health `bot_not_in_channel`. A private channel the bot is not in is reported this way. |
| invite | `user_not_found` | Value passed for `users` was invalid. | Per-member error. |
| invite | `cant_invite`, `user_is_restricted`, `ura_max_channels`, `no_permission` | Per-user restrictions. | Per-member error; other channels continue. |
| invite, join | `is_archived` | Channel has been archived. | Health `error`. |
| invite, kick, join | `method_not_supported_for_channel_type` | This type of conversation cannot be used with this method. | Health `error` (or `bot_not_in_channel` from join). |
| kick | `not_in_channel` | User was not in the channel. | Confirmed with `conversations.info`: if the bot is a member, success (idempotent). If not and the channel is public, join and retry once. Private: `bot_not_in_channel`. |
| kick | `cant_kick_self` | Authenticated user can't kick themselves from a channel. | Skipped. |
| kick | `cant_kick_from_general` | User cannot be removed from #general. | Skipped. |
| kick | `restricted_action` | Team preference prevents user from kicking. | Health `error` with the runbook link. Not retried. |
| lookupByEmail | `users_not_found` | (no account for the email) | Per-member warning (`skipped`). Not retried. `user_not_found` is accepted as a synonym. |
| all | `missing_scope`, `invalid_auth`, `not_authed`, `account_inactive`, `token_revoked`, `token_expired`, `not_allowed_token_type`, `team_access_not_granted`, `enterprise_is_restricted` | Credential or scope problems. | Every channel of the team gets health `error`; the job fails permanently. |
| all | `ratelimited` | Request has been rate-limited. | `RetryAfterError` with the `Retry-After` value (30 s if absent). |
| all | `internal_error`, `fatal_error`, `service_unavailable`, `request_timeout`, non-JSON 5xx | Transient. | Remaining channels are processed, then the job retries with backoff. |

Note: `users.lookupByEmail` documents `users_not_found` (plural). `user_not_found` is the
code `conversations.invite` and `conversations.kick` use for a bad user id.

## Rate limits

Source: https://docs.slack.dev/apis/web-api/rate-limits

- Tier 1: 1+ per minute, Tier 2: 20+, Tier 3: 50+, Tier 4: 100+.
- Limits apply per method, per workspace, per app.
- When limited, Slack returns HTTP 429 with a `Retry-After` header in seconds. The client
  throws `RetryAfterError` and the job worker reschedules the job for that time.
- Each sync job makes at most one lookup plus one to four channel calls per linked channel,
  so normal roster changes stay far below Tier 3. A full resync of a large team enqueues one
  job per member and may hit the limit; the jobs then back off and continue.

## Other facts

- `conversations.join` works on public channels only in practice; the method lists
  `method_not_supported_for_channel_type` and `channel_is_limited_access`. The bot must be
  invited to private channels by a member (`/invite @BTC Scheduler`).
- `conversations.invite` accepts up to 1000 comma-separated user ids. The sync invites one
  user per call so errors are attributed to a single member.
- `chat.postMessage` with only `chat:write` cannot post to a public channel the bot has not
  joined; that needs `chat:write.public`, which this app does not request. Invite the bot to
  the admin notice channel.
- Workspace setting: by default owners and admins can remove people from public channels and
  members can remove people from private channels. Owners can restrict this under
  Settings & administration > Workspace settings > Permissions > Channel Management
  ("People who can remove members from public channels" and the private channel equivalent).
  When the app is not allowed, `conversations.kick` returns `restricted_action`.
  Sources: https://slack.com/help/articles/201898668-Remove-someone-from-a-channel and
  https://support.toriihq.com/hc/en-us/articles/25553252231323
- App manifest: `display_information.name` is at most 35 characters. The reference lists
  `a-z`, `0-9`, `-`, `_`, `.` for `features.bot_user.display_name`, while Slack's own example
  uses spaces and capitals. Source: https://docs.slack.dev/reference/app-manifest
