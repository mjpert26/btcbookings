import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
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
  link_pending: {
    title: "An administrator needs to confirm your account",
    body: "Your name matches an account that was moved over from Calendly. An administrator must confirm it is yours before you can sign in. Please ask an administrator, then sign in again.",
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
    body: "Sign-in is temporarily unavailable. Please try again later or contact support.",
  },
  no_id_token: {
    title: "Microsoft did not confirm your identity",
    body: "No identity token was returned. Please try again or contact IT.",
  },
};

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
            <StaggeredText text="Team sign in." as="span" className="block" delay={110} startDelay={150} />
          </h1>
          <p className="btc-fade-up mt-5 max-w-md text-base text-white/85 [animation-delay:600ms] sm:text-lg">
            For Big Think Capital employees.
          </p>

        </section>

        <section aria-labelledby="signin-heading" className="btc-fade-up w-full [animation-delay:250ms] lg:justify-self-end">
          <SpotlightTilt className="w-full max-w-md rounded-3xl lg:ml-auto">
            <div className="rounded-3xl border border-white/40 bg-white/95 p-7 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-9">
              <Image src={brand.logo.light.src} alt={brand.logo.alt} width={brand.logo.light.width} height={brand.logo.light.height} priority className="h-12 w-auto" />
              <h2 id="signin-heading" className="mt-7 text-2xl font-bold">
                Sign in to {brand.productName}
              </h2>
              <p className="mt-2 text-sm text-muted">Use your Big Think Capital Microsoft 365 account.</p>

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
                Big Think Capital accounts only.
              </div>
              <p className="mt-3 text-xs text-muted">
                Trouble signing in? Contact <a className="font-medium text-primary underline" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>.
              </p>
            </div>
          </SpotlightTilt>
        </section>
      </div>

      <p className="pb-6 text-center text-xs text-white/60"><Link href="/" className="hover:text-white">{brand.name}</Link></p>
    </main>
  );
}
