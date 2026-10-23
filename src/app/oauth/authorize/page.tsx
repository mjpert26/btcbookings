import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { brand } from "@/theme/brand";
import { getSessionUser } from "@/server/auth/session";
import { OAuthError, validateAuthorizeRequest } from "@/server/oauth/server";
import { can, ROLE_LABEL } from "@/lib/permissions";
import { Consent } from "./Consent";

export const metadata: Metadata = { title: "Connect an app" };
export const dynamic = "force-dynamic";

function scopeLines(role: Parameters<typeof can>[0]): string[] {
  const lines = [
    can(role, "bookings.read_all") ? "See all bookings" : "See your bookings",
    "Find open times and schedule, reschedule or cancel meetings (invitees are notified)",
    can(role, "pages.manage_all") ? "Create and change any booking page and its questions" : "Create and change your booking pages and those of teams you manage",
    "See teams and the user directory",
  ];
  if (can(role, "users.manage")) lines.push("Add users and change roles");
  if (can(role, "audit.read")) lines.push("Read the audit log");
  return lines;
}

/** OAuth consent screen for MCP clients (Claude and others). */
export default async function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") params.set(k, v);
  const query = params.toString();

  const user = await getSessionUser();
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/oauth/authorize?${query}`)}`);

  let request: Awaited<ReturnType<typeof validateAuthorizeRequest>> | null = null;
  let problem: string | null = null;
  try {
    request = await validateAuthorizeRequest(params);
  } catch (err) {
    problem = err instanceof OAuthError ? err.description : "The authorization request is invalid.";
  }

  return (
    <main id="main" className="flex min-h-screen flex-1 items-center justify-center bg-surface-alt px-4 py-12">
      <section aria-labelledby="consent-heading" className="w-full max-w-lg rounded-3xl border border-border bg-white p-7 shadow-xl sm:p-9">
        <Image src={brand.logo.light.src} alt={brand.logo.alt} width={brand.logo.light.width} height={brand.logo.light.height} priority className="h-10 w-auto" />
        {request ? (
          <>
            <h1 id="consent-heading" className="mt-6 text-2xl font-bold text-ink">
              Allow {request.client.name} to use {brand.productName}?
            </h1>
            <p className="mt-2 text-sm text-muted">
              It will act as <span className="font-semibold text-ink">{user.name}</span> ({ROLE_LABEL[user.role]}) with your current permissions. You can disconnect it at any time under Settings &gt; Integrations.
            </p>
            <ul className="mt-6 space-y-2 text-sm text-ink">
              {scopeLines(user.role).map((l) => (
                <li key={l} className="flex gap-2">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  {l}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-xs text-muted">After you allow access you return to {new URL(request.redirectUri).host}.</p>
            <Consent query={query} />
          </>
        ) : (
          <>
            <h1 id="consent-heading" className="mt-6 text-2xl font-bold text-ink">
              This connection request cannot be completed
            </h1>
            <p role="alert" className="mt-3 text-sm text-danger">
              {problem}
            </p>
            <p className="mt-3 text-sm text-muted">Start the connection again from the app you were using. If the app&apos;s callback URL is new, an admin can allow it under Admin &gt; Integrations.</p>
          </>
        )}
      </section>
    </main>
  );
}
