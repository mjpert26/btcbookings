# Public home page: routing visitors by email

The public home page (`/`) sends returning applicants and customers straight to the right booking page, and new visitors to the next available advisor. It works like Calendly's Salesforce routing form: the visitor types an email and is redirected at once, without email verification.

Signed-in employees who open `/` are still redirected to `/dashboard`. Staff sign in at `/login`; the home page and the public 404 page no longer link to it.

## What visitors see

- **Already applied or already a customer?** An email field. On submit, the app looks the email up in Salesforce (through n8n), decides where the visitor belongs and opens that booking page. While the lookup runs, the button shows "Looking you up…"; errors (empty or invalid email, too many attempts, failed verification) are announced in an `aria-live` region and focus returns to the field. When no page can be offered, a short message with a link to the company website (`brand.websiteUrl`) is shown and receives focus.
- **New here?** A button that opens the new-business page (a team round-robin or collective page). It is shown only when that page is configured in Admin > Home page and active.
- **Language.** English or Spanish, chosen like other pages without an explicit language: the `btc_locale` cookie, else the browser's `Accept-Language` (`src/i18n/request.ts`). The button in the header switches language by setting the cookie. Spanish visitors are sent to the Spanish variant of the destination page when an active one exists, otherwise to the page itself. Texts are in the `home` namespace of `messages/en.json` and `messages/es.json`.
- The page keeps the Aurora background and brand tokens, works at phone width, and is fully usable with a keyboard. Cloudflare Turnstile is shown under the field when the site key is set.

## Routing rules

The decision is a pure function in the app (`decideRoute()` in `src/server/home/decide.ts`), not in n8n. Rules apply in this order:

1. **Account manager (open deal).** An open, non-renewal Opportunity that is not funded and whose owner is a real owner: that owner. When several qualify, the most recently modified wins.
2. **Renewal.** An open Opportunity marked renewal, or any funded Opportunity: route to renewals with the renewal book of an open renewal Opportunity (the most recently modified), else of the most recently modified funded one. For an open renewal Opportunity, its owner and its renewal closer, when real, are carried as preferred people (owner first).
3. **Account manager (open lead).** An open Lead whose owner is a real user (not a queue): that owner, newest Lead first.
4. **New applicant.** Everything else, including every lookup failure.

A **real owner** is active, a standard Salesforce user (for Opportunity owners `UserType = 'Standard'`; for Lead owners an owner of type User), has an email domain in `ALLOWED_EMAIL_DOMAINS` (default `bigthinkcapital.com`), and is not on the excluded owner list in Admin > Home page. A renewal closer must be active, in an allowed domain and not excluded. Equal dates keep the order n8n returned.

Funded Opportunities count as renewal signals even when they are still open (for example the stage Renewal Prospecting), so they never route to their owner under rule 1.

### Destinations

`resolveDestination()` in `src/server/home/destination.ts` turns the decision into a booking page:

- **Account manager.** The owner's email is matched case-insensitively to an active app user with a healthy Outlook connection. Their default page is an active, listed personal event type, preferring the slugs `15min`, then `30min`, then `financing-intro-call`, else their only active listed page. If any step fails (no app user, no healthy calendar, no clear default page), the visitor is routed as new.
- **Renewal.** The page configured for the book (`renewal_books`), else the default renewal page; a paused page is skipped. If a preferred person is a bookable app user and an eligible host of that renewal page (active team member, included in the page's host list when it has one, healthy calendar), the visitor goes to that person's default page instead. With no active renewal page, the visitor is routed as new.
- **New.** The new-business page when configured and active; otherwise no page, and the home page shows the fallback with the website link.

Only a relative path (`/{user}/{event}`, `/t/{team}/{event}`, with `/es` for Spanish variants) is ever returned to the browser.

## The lookup endpoint

`POST /api/public/lookup` with `{ email, turnstileToken, lang }` (`src/app/api/public/lookup/route.ts`). Steps, as for `/api/public/book`:

1. `Origin` must equal `APP_BASE_URL` (403 `forbidden`).
2. At most 5 requests per hashed IP per 10 minutes (429 `rate_limited`).
3. Zod body: `email` (at most 254 characters, a valid address), `turnstileToken`, `lang` (`en` or `es`, default `en`) (400 `invalid`).
4. At most 3 requests per email per 10 minutes, keyed by a hash of the email.
5. Turnstile with action `lookup`, skipped when no secret key is set (400 `verification_failed`).
6. A global cap of 1000 lookups per day. At the cap the Salesforce lookup is skipped and the visitor is routed as new, so the page still works.
7. Lookup, decision and destination.

The answer is always `200 { "next": string | null }`, whatever the outcome. It never says whether the email was found and never contains ids, emails, names, the route or the renewal book. n8n failures, timeouts (5 seconds), invalid answers and a missing token all route as new. Logs contain only a short reason such as `status_502` or `timeout`, never the email.

## Configuration: Admin > Home page

`/admin/home-routing`, global admins only. Stored in the single-row table `app.home_routing`.

- **New-business page.** A team round-robin or collective page (the list shows team, page, languages and Active or Paused). Leave it empty to hide the New here? button.
- **Renewal pages.** One page per renewal book (`Book 1`, `Book 2`, `Book 3`, `House Book`, the values of `Account.Renewal_Book__c`) and a default renewal page used for other books and when a book's page is not set or paused. Team and personal pages can be chosen.
- **Excluded Salesforce owners.** One email per line, at most 100, lowercased and deduplicated. Shared, queue-like and integration users that must never count as an account manager. Seeded with the shared Jessica Marks users, `teamaxkap@`, `teamdc@`, `sdr.roundrobin@bigthinkcapital.com` and `shaine@forml.ai`.
- **Test an email.** Runs the same lookup and rules for one email and shows the Salesforce lookup status, the decision, the matched owner or preferred person, the renewal book, the destination and the path. Nothing is changed, booked or sent; the audit log records that a test ran (`home_routing.test`) with the outcome, without the email.

Every save runs as the signed-in admin under row-level security and writes an audit entry (`home_routing.update`, entity type `home_routing`) in the same transaction. Only admins can read or change the row; the public endpoint reads it on the service connection and selects only the columns it needs.

All booking pages involved must be active, and the reps on them must have connected Outlook. Otherwise the page shows no times, or the visitor falls through to the next option.

## Salesforce lookup through n8n

The app never calls Salesforce directly. It sends `POST {N8N_BASE_URL}{N8N_LOOKUP_WEBHOOK_PATH}` (default `https://api.bigthinkcapital.com/webhook/btc-scheduler/lookup`) with `{ "email": "<lowercased, trimmed>" }` and `Authorization: Bearer <N8N_LOOKUP_TOKEN>`, and waits at most 5 seconds (`src/server/home/lookup.ts`). Without `N8N_LOOKUP_TOKEN` the call is skipped.

Workflow file: `n8n/account-manager-lookup.json` ("BTC Scheduler - Account Manager Lookup"):

1. **Lookup Webhook** (POST `btc-scheduler/lookup`, Header Auth, responds from a Respond node).
2. **Validate Email**: not a plausible email gives 400 `{ "error": "invalid_email" }`. The email is lowercased and escaped for SOQL (backslash first, then the single quote).
3. **Get SF Token**: the SF Token Broker (`7wen5ULQg7DBlCvC`).
4. **Query Opportunities**: Opportunities where the email is `csbs__Owner__r.Email` or `csbs__Owner_2__r.Email`, open or in the stages Funded and Renewal Prospecting, at most 50.
5. **Query Leads**: unconverted Leads with that email, at most 10.
6. **Shape Response**: maps the records to the contract below. No Salesforce Ids, names, stages or merchant fields leave the workflow. A failed query gives 502 `{ "error": "lookup_failed" }`.
7. **Respond**.

Response (validated with Zod in the app; arrays capped at 50 and 10):

```json
{
  "opportunities": [
    {
      "open": true,
      "renewal": false,
      "funded": false,
      "lastModified": "2026-11-10T15:20:00.000Z",
      "owner": { "email": "rep@bigthinkcapital.com", "active": true, "standard": true },
      "renewalCloser": { "email": "closer@bigthinkcapital.com", "active": true },
      "book": "Book 1"
    }
  ],
  "leads": [
    { "createdAt": "2026-10-01T09:00:00.000Z", "owner": { "email": "rep@bigthinkcapital.com", "active": true, "isUser": true } }
  ]
}
```

Mapping: `open = !IsClosed`; `renewal = Is_Renewal_Type__c or StageName = 'Renewal'`; `funded = StageName in ('Funded', 'Renewal Prospecting')`; owner `standard = Owner.UserType = 'Standard'`; Lead owner `isUser = Owner.Type = 'User'`; `book = Account.Renewal_Book__c`. Emails are lowercased; dates are ISO 8601 in UTC.

Workflow settings: execution order v1; successful and failed execution data are not saved and manual executions are not saved (requests contain merchant emails); callable only by workflows from the same owner; error workflow `Q3Ld5IrQCtGimErY`; time zone America/New_York.

### Import and activate

1. In n8n on api.bigthinkcapital.com, open Mike Perticone's personal project (`tPYBDOQFrX8Bp1vZ`), go to the folder **book.bigthinkcapital.com**, and import `n8n/account-manager-lookup.json`. It must be in the same project as the SF Token Broker, which accepts calls only from workflows with the same owner.
2. Generate a token of at least 32 characters, for example `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
3. Create a Header Auth credential named **BTC Scheduler lookup token** with header name `Authorization` and value `Bearer <token>`. The workflow file names this credential with the placeholder id `REPLACE_WITH_CREDENTIAL_ID`; select the credential on the **Lookup Webhook** node after import.
4. In BTC Scheduler, set the same token as `N8N_LOOKUP_TOKEN` in **Admin > Settings** (group Salesforce and n8n).
5. Activate the workflow. Use **Admin > Home page > Test an email** with an employee test record to check the lookup (Salesforce answered) and the routing.
6. Configure the new-business page, the renewal pages and the excluded owners in Admin > Home page.

## Privacy and abuse

The redirect is instant, like Calendly's routing form: anyone who knows a customer's email can open that customer's advisor's booking page. That page is public anyway; the response never confirms whether the email exists in Salesforce and never reveals names, emails, the route or the book. Abuse is limited by the same-origin check, Turnstile (when configured), per-IP and per-email rate limits, and the daily lookup cap, after which no Salesforce lookups are made.

## Files

- `src/app/page.tsx`, `src/components/public/HomeLookup.tsx`: the home page.
- `src/app/api/public/lookup/route.ts`: the lookup endpoint.
- `src/server/home/`: decision (`decide.ts`), n8n client (`lookup.ts`), destinations and configuration (`destination.ts`), the shared flow (`route.ts`), admin functions (`admin.ts`).
- `src/app/(app)/admin/(admin-only)/home-routing/`, `src/app/(app)/admin/_actions/home-routing.ts`: Admin > Home page.
- `supabase/migrations/20261116120000_home_routing.sql`: `app.home_routing` and the `N8N_LOOKUP_TOKEN` settings key.
- Tests: `tests/unit/home-decide.test.ts`, `tests/unit/home-lookup.test.ts`, `tests/unit/n8n-lookup-workflow.test.ts`, `tests/integration/home-routing.test.ts`.
