import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { brand } from "@/theme/brand";
import { getSessionUser } from "@/server/auth/session";
import { safeReturnTo } from "@/server/http/redirects";
import SilkBackground from "@/components/reactbits/SilkBackground";
import LetterSwap from "@/components/reactbits/LetterSwap";
import { BTC_SILK_COLORS } from "@/components/reactbits/SilkWaves";

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
    <main id="main" className="grid min-h-screen flex-1 lg:grid-cols-[1.1fr_1fr]">
      <section
        aria-labelledby="login-hero"
        className="relative isolate flex min-h-56 flex-col justify-end overflow-hidden bg-gradient-to-br from-navy via-[#0b4f84] to-primary px-6 py-10 sm:px-10 lg:min-h-screen lg:p-14"
      >
        <div className="absolute inset-0 -z-10 opacity-70">
          <SilkBackground colors={BTC_SILK_COLORS} speed={0.35} scale={1.6} distortion={0.8} rotation={-12} brightness={0.95} />
        </div>
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-t from-navy/90 via-navy/40 to-transparent" />
        <p className="font-heading text-sm font-semibold uppercase tracking-[0.2em] text-white/85">{brand.name}</p>
        <h1 id="login-hero" className="mt-3 max-w-xl font-heading text-3xl font-bold leading-tight text-white sm:text-4xl lg:text-5xl">
          <LetterSwap text="Scheduling, simplified." as="span" className="block" />
        </h1>
        <p className="mt-4 max-w-md text-base text-white/90">
          Share your booking page, sync with Outlook, and route meetings across your team. All in one place.
        </p>
      </section>

      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <Image src={brand.logo.light.src} alt={brand.logo.alt} width={brand.logo.light.width} height={brand.logo.light.height} priority className="h-14 w-auto" />
          <h2 className="mt-8 text-2xl font-bold">Sign in to {brand.productName}</h2>
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

          <a
            href={loginHref}
            className="mt-8 flex h-12 w-full items-center justify-center gap-3 rounded-lg bg-primary px-5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover"
          >
            <svg aria-hidden="true" viewBox="0 0 21 21" className="size-5">
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Sign in with Microsoft
          </a>

          <p className="mt-6 text-xs text-muted">
            Trouble signing in? Contact <a className="font-medium text-primary underline" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>.
          </p>
        </div>
      </section>
    </main>
  );
}
