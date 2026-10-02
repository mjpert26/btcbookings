This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Public booking pages (BTC Scheduler)

- Routes: `/<userSlug>`, `/<userSlug>/<eventSlug>[/es]`, `/t/<teamSlug>`, `/t/<teamSlug>/<eventSlug>[/es]`, and the invitee manage page `/b/<token>` (plus `/b/<token>/ics`). APIs: `GET /api/public/slots`, `POST /api/public/book`, `POST /api/public/manage`. A user slug of `t`, `b` or `api` is unreachable as a public page because those segments are reserved.
- Service code: `src/server/booking/*` (load, slots, create, manage, reassign job) and `src/server/email/*` (Resend sender, React Email templates, `email_send` job).
- Environment: `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` enable bot protection (required in production; skipped in development when unset). Without `RESEND_API_KEY`, emails are logged (redacted) instead of sent.
- Migration `20261002600000_booking.sql` adds `bookings.manage_token_enc` and replaces app_user's table-level SELECT on `app.bookings` with a column list. Code running as app_user must list columns explicitly; `select *` on `app.bookings` fails.
- Tests: `pnpm test:unit`, `pnpm test:integration` (set `TEST_DATABASE_URL` to use a separate database), and `pnpm test:e2e`. The e2e run seeds `btc_e2e_booking` (`tests/e2e/seed.ts`) and starts `next dev` on port 3417 (`E2E_PORT` overrides). Set `PLAYWRIGHT_CHROMIUM_PATH` to use a preinstalled Chromium.
