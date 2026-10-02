import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { brand } from "@/theme/brand";
import { getSessionUser } from "@/server/auth/session";
import { safeReturnTo } from "@/server/http/redirects";
import AuroraBackground from "@/components/reactbits/AuroraBackground";
import StaggeredText from "@/components/reactbits/StaggeredText";
import SpotlightTilt from "@/components/reactbits/SpotlightTilt";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, { title: string; body: string }> = {
  access_denied: {
    title: "Sign-in was cancelled",
    body: "Microsoft reported that access was declined. Try again and accept the permissions request.",
  },
  not_allowed: {
    title: "This account cannot sign in",
    body: "Only active Big Think Capital Microsoft 365 accounts can use BTC Scheduling. Contact an administrator if you think this is a mistake.",
  },
  state_expired: {
    title: "Your sign-in link expired",
    body: "The sign-in took too long or was opened in another tab. Please start again.",
  },
  signin_failed: {
    title: "We could not complete sign-in",
    body: "Something went wrong while finishing your sign-in. Please try again in a moment.",
  },
  entra_error: {
    title: "Microsoft returned an error",
    body: "Microsoft Entra ID could not complete the request. Try again, and contact IT if it keeps happening.",
  },
  invalid_request: {
    title: "The sign-in request was invalid",
    body: "The response from Microsoft was incomplete. Please start the sign-in again.",
  },
  server_config: {
    title: "Sign-in is not available yet",
    body: "BTC Scheduling is not fully configured on the server, so sign-in cannot start. An administrator needs to finish setup (database and required settings). Details are in the server logs.",
  },
  no_id_token: {
    title: "Microsoft did not confirm your identity",
    body: "No identity token was returned. Please try again or contact IT.",
  },
};

const FEATURES = [
  {
    title: "Outlook, always in sync",
    body: "Busy time blocks your slots and every booking lands on your calendar with a Teams link.",
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="size-4">
        <path d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-6.5c0-.69-.56-1.25-1.25-1.25H4.75Z" />
      </svg>
    ),
  },
  {
    title: "Fair round-robin",
    body: "Team pages route to whoever is free, synced with your Salesforce queues.",
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="size-4">
        <path fillRule="evenodd" d="M15.3 5.2a.75.75 0 0 1 0 1.06l-1.47 1.47h.42a4.25 4.25 0 0 1 0 8.5h-1.5a.75.75 0 0 1 0-1.5h1.5a2.75 2.75 0 0 0 0-5.5h-.42l1.47 1.47a.75.75 0 1 1-1.06 1.06l-2.75-2.75a.75.75 0 0 1 0-1.06l2.75-2.75a.75.75 0 0 1 1.06 0ZM4.7 14.8a.75.75 0 0 1 0-1.06l1.47-1.47h-.42a4.25 4.25 0 0 1 0-8.5h1.5a.75.75 0 0 1 0 1.5h-1.5a2.75 2.75 0 0 0 0 5.5h.42L4.7 9.3a.75.75 0 0 1 1.06-1.06l2.75 2.75a.75.75 0 0 1 0 1.06L5.76 14.8a.75.75 0 0 1-1.06 0Z" clipRule="evenodd" />
      </svg>
    ),
  },
  {
    title: "English y Español",
    body: "Spanish booking pages route to Spanish-speaking reps automatically.",
    icon: (
      <svg viewBox="0 0 20 20" fill="currentColor" className="size-4">
        <path d="M7.75 2.75a.75.75 0 0 0-1.5 0v1.26a48.4 48.4 0 0 0-3.48.27.75.75 0 1 0 .16 1.49 46.9 46.9 0 0 1 5.84-.24 9.44 9.44 0 0 1-2.53 4.24 9.4 9.4 0 0 1-1.12-1.63.75.75 0 1 0-1.33.69c.36.7.8 1.36 1.31 1.96a9.44 9.44 0 0 1-2.4 1.2.75.75 0 1 0 .48 1.42 10.94 10.94 0 0 0 3.04-1.6c.52.4 1.07.75 1.65 1.05a.75.75 0 0 0 .69-1.33c-.43-.22-.84-.47-1.22-.76a10.94 10.94 0 0 0 2.9-5.1c.4.02.8.05 1.2.09a.75.75 0 1 0 .14-1.5 48.2 48.2 0 0 0-3.83-.23V2.75ZM13 8a.75.75 0 0 1 .69.46l3.5 8.25a.75.75 0 1 1-1.38.58L15.04 15.5h-4.08l-.77 1.79a.75.75 0 1 1-1.38-.58l3.5-8.25A.75.75 0 0 1 13 8Zm-1.4 6h2.8L13 10.7 11.6 14Z" />
      </svg>
    ),
  },
];

const FALLBACK_ERROR = { title: "Sign-in did not complete", body: "Please try again." };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const returnTo = safeReturnTo(one(sp.returnTo));
  const user = await getSessionUser();
  if (user) redirect(returnTo);

  const errorCode = one(sp.error);
  const error = errorCode ? (ERRORS[errorCode] ?? FALLBACK_ERROR) : null;
  const signedOut = one(sp.signedOut) === "1";
  const loginHref = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main id="main" className="relative isolate flex min-h-screen flex-1 flex-col overflow-hidden bg-gradient-to-br from-navy via-[#0b4f84] to-primary">
      {/* Full-bleed aurora; the CSS gradient above shows until WebGL loads or if it is unavailable. */}
      <div className="absolute inset-0 -z-10">
        <AuroraBackground speed={0.9} brightness={1.3} bloomIntensity={2.3} opacity={0.95} />
      </div>
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,transparent_20%,rgb(6_34_59/0.55)_75%)]" />

      <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-5 py-10 sm:px-8 lg:grid-cols-[1.15fr_1fr] lg:gap-16 lg:py-16">
        <section aria-labelledby="login-hero" className="text-white">
          <Image
            src={brand.logo.mark.src}
            alt=""
            width={56}
            height={56}
            priority
            className="btc-fade-up size-12 rounded-xl bg-white/95 p-1.5 shadow-lg shadow-black/20 sm:size-14"
          />
          <p className="btc-fade-up mt-6 font-heading text-xs font-semibold uppercase tracking-[0.25em] text-sky [animation-delay:120ms] sm:text-sm">
            {brand.name}
          </p>
          <h1 id="login-hero" className="mt-3 font-heading text-4xl font-extrabold leading-[1.05] text-white sm:text-5xl lg:text-6xl">
            <StaggeredText text="Scheduling, simplified." as="span" className="block" delay={110} startDelay={150} />
          </h1>
          <p className="btc-fade-up mt-5 max-w-md text-base text-white/85 [animation-delay:600ms] sm:text-lg">
            Share your booking page, sync with Outlook, and route every meeting to the right rep.
          </p>

          <ul className="mt-8 hidden max-w-md gap-3 sm:grid">
            {FEATURES.map((f, i) => (
              <li
                key={f.title}
                className="btc-fade-up flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 backdrop-blur-sm"
                style={{ animationDelay: `${750 + i * 120}ms` }}
              >
                <span aria-hidden="true" className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-sky/20 text-sky">
                  {f.icon}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-white">{f.title}</span>
                  <span className="block text-sm text-white/75">{f.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="signin-heading" className="btc-fade-up w-full [animation-delay:250ms] lg:justify-self-end">
          <SpotlightTilt className="w-full max-w-md rounded-3xl lg:ml-auto">
            <div className="rounded-3xl border border-white/40 bg-white/95 p-7 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-9">
              <Image src={brand.logo.light.src} alt={brand.logo.alt} width={brand.logo.light.width} height={brand.logo.light.height} priority className="h-12 w-auto" />
              <h2 id="signin-heading" className="mt-7 text-2xl font-bold">
                Sign in to {brand.productName}
              </h2>
              <p className="mt-2 text-sm text-muted">Use your Big Think Capital Microsoft 365 account. Your Outlook calendar connects automatically.</p>

              {signedOut && !error ? (
                <div role="status" className="mt-6 rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm text-success">
                  You have been signed out.
                </div>
              ) : null}

              {error ? (
                <div role="alert" className="mt-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
                  <p className="font-semibold text-danger">{error.title}</p>
                  <p className="mt-1 text-ink">{error.body}</p>
                </div>
              ) : null}

              <div className="btc-glow-border mt-8 rounded-xl">
                <a
                  href={loginHref}
                  className="flex h-12 w-full items-center justify-center gap-3 rounded-xl bg-primary px-5 text-base font-semibold text-white transition-colors hover:bg-primary-hover"
                >
                  <svg aria-hidden="true" viewBox="0 0 21 21" className="size-5">
                    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                  </svg>
                  Sign in with Microsoft
                </a>
              </div>

              <div className="mt-6 flex items-center gap-2 text-xs text-muted">
                <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 text-success" fill="currentColor">
                  <path fillRule="evenodd" d="M10 1.5 3 4.5v5c0 4.2 3 7.9 7 9 4-1.1 7-4.8 7-9v-5l-7-3Zm3.2 6.3a.75.75 0 0 0-1.1-1l-3 3.3-1.2-1.2a.75.75 0 1 0-1.06 1.06l1.75 1.75a.75.75 0 0 0 1.08-.03l3.53-3.88Z" clipRule="evenodd" />
                </svg>
                Single sign-on with Microsoft Entra ID. BTC accounts only.
              </div>
              <p className="mt-3 text-xs text-muted">
                Trouble signing in? Contact <a className="font-medium text-primary underline" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>.
              </p>
            </div>
          </SpotlightTilt>
        </section>
      </div>

      <p className="pb-6 text-center text-xs text-white/60">{brand.productName} · Internal use only</p>
    </main>
  );
}
