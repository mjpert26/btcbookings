# Application error log

Server errors are recorded in `app.error_log` so admins can review and resolve them at **Admin > Errors** (`/admin/errors`). Access requires the `errors.read` capability (admins only); row-level security returns nothing to other roles.

## What is captured

| Source | Captured by |
|---|---|
| `page` | Server Component render errors, through the `onRequestError` hook in `src/instrumentation.ts` |
| `action` | Server action errors, through `onRequestError` |
| `route` | Route handler and proxy errors, through `onRequestError` |
| `cron` | Errors thrown by `/api/cron/*` route handlers, through `onRequestError` |
| `api`, `mcp` | Errors thrown by `/api/v1/*` and `/mcp` handlers through `onRequestError`, and errors those modules record themselves with `logError()` |
| `job` | Failed attempts in the jobs worker (`src/server/jobs/worker.ts`), both retried and dead, plus jobs with no handler. The route is the job kind; the payload is never stored |
| `client` | Reserved for browser error reports |

Next.js redirect, not-found and similar control-flow signals are ignored. Errors that a module catches and handles are not recorded unless the module calls `logError()`.

## Recording an error from code

```ts
import { logError } from "@/server/errors/log";

try {
  // ...
} catch (err) {
  await logError(err, { source: "api", route: "/api/v1/bookings/[id]", method: "POST", context: { bookingId } });
  throw err;
}
```

`logError()` never throws. It writes with the service connection outside the caller's transaction, so an entry survives a rollback. Pass only small, non-personal context such as ids, kinds and counts.

A write is bounded: it runs in its own short transaction with a 2 s lock timeout and a 3 s statement timeout, and the call gives up after 5 s in total (`LOG_WRITE_LIMITS`). In a route handler, use `logErrorAfterResponse()` instead, which schedules the write with `after()` so that the error response is sent first; the REST API (`apiRoute`) and MCP tool errors do this. Outside a request it writes before returning.

## Grouping

Each entry has a fingerprint: a SHA-256 of the source, route, error name and the message with UUIDs, long identifiers, hex strings and numbers replaced. A repeat of an unresolved error increments `occurrences` and moves `last_seen_at`; the latest message, stack and context replace the stored ones. A unique index allows one unresolved entry per fingerprint, so an error that happens again after it was resolved opens a new entry.

## Redaction and limits

Before anything is stored (`src/server/errors/sanitize.ts`):

- Bearer and Basic credentials, `btc_pat_`, `btc_at_` and `btc_rt_` tokens, Slack tokens, JWT-like strings, cookie headers, secret-named `key=value` and `"key": "value"` pairs (including prefixed keys such as `refreshToken`, `clientSecret` or `x_api_key`) and sensitive URL query parameters are replaced with `[redacted]` or `[jwt]`.
- Email addresses, phone numbers and digit runs of seven or more are replaced with `[email]`, `[phone]` and `[number]`.
- Request errors store the route file pattern (for example `/(public)/b/[token]/manage/page`), never the request path, query string or headers. Other routes have their query string removed and identifier-like segments replaced with `:id`: UUIDs, numbers, any segment of 32 or more letters, digits, `_` or `-` (such as a manage token), long segments that contain a digit, and segments that contain `@` once percent-decoded.
- Context keys that name secrets or personal data (token, password, cookie, authorization, email, phone, body, payload, headers and similar) are dropped. Context is limited to 4 levels, 30 keys, 20 array items and about 4 KB.
- Messages are truncated to 2,000 characters and stacks to 8,000.

## Resolving

**Resolve** marks an entry handled; **Reopen** reverses it. Both write an audit entry (`error.resolve`, `error.reopen`) with the changed fields. Reopening is refused while a newer unresolved entry with the same fingerprint exists.

## Retention

The daily maintenance cron (`/api/cron/maintenance`) deletes resolved entries 90 days after they were resolved, and any entry not seen for 180 days.

## Useful queries

```sql
-- Unresolved errors by source
select source, count(*), sum(occurrences) from app.error_log where resolved_at is null group by 1 order by 2 desc;

-- Most frequent unresolved errors
select source, route, error_name, message, occurrences, last_seen_at
from app.error_log where resolved_at is null order by occurrences desc limit 20;
```
