import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { brand } from "@/theme/brand";
import { getSessionUser } from "@/server/auth/session";
import AuroraBackground from "@/components/reactbits/AuroraBackground";
import StaggeredText from "@/components/reactbits/StaggeredText";

export const metadata: Metadata = { title: brand.name };
export const dynamic = "force-dynamic";

/**
 * Public landing page. Customers normally arrive on a specific booking link, so this page only
 * introduces the brand and points elsewhere. It must not describe internal tooling.
 * Signed-in employees go straight to their dashboard.
 */
export default async function Home() {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");

  return (
    <main id="main" className="relative isolate flex min-h-screen flex-1 flex-col overflow-hidden bg-gradient-to-br from-navy via-[#0b4f84] to-primary text-white">
      <div className="absolute inset-0 -z-10">
        <AuroraBackground speed={0.8} brightness={1.25} bloomIntensity={2.2} opacity={0.95} />
      </div>
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,transparent_20%,rgb(6_34_59/0.55)_75%)]" />

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <span className="flex items-center gap-3">
          <Image src={brand.logo.mark.src} alt="" width={40} height={40} priority className="size-10 rounded-lg bg-white/95 p-1 shadow-md shadow-black/20" />
          <span className="font-heading text-sm font-semibold uppercase tracking-[0.2em] text-white/90 max-sm:sr-only">{brand.name}</span>
        </span>
        <Link href="/login" className="whitespace-nowrap rounded-lg border border-white/25 px-3 py-1.5 text-sm font-medium text-white/90 hover:bg-white/10">
          Team sign in
        </Link>
      </header>

      <section aria-labelledby="home-heading" className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-5 pb-16 text-center sm:px-8">
        <h1 id="home-heading" className="font-heading text-4xl font-extrabold leading-[1.05] text-white sm:text-6xl">
          <StaggeredText text="Let's talk about your business." as="span" className="block" delay={90} startDelay={150} />
        </h1>
        <p className="btc-fade-up mt-6 max-w-xl text-base text-white/85 [animation-delay:600ms] sm:text-lg">
          Have a booking link from your {brand.name} advisor? Open it to pick a time that works for you.
        </p>
        <div className="btc-fade-up mt-9 flex flex-col gap-3 [animation-delay:800ms] sm:flex-row">
          <a
            href={brand.websiteUrl}
            className="inline-flex h-12 items-center justify-center rounded-xl bg-white px-6 text-base font-semibold text-navy shadow-lg shadow-black/20 hover:bg-white/90"
          >
            Visit {brand.websiteUrl.replace(/^https?:\/\/(www\.)?/, "")}
          </a>
        </div>
      </section>

      <footer className="pb-6 text-center text-xs text-white/60">
        © {new Date().getFullYear()} {brand.name}
      </footer>
    </main>
  );
}
