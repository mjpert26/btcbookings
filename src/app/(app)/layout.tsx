import { Suspense } from "react";
import { requireUser } from "@/server/auth/session";
import { AppNav } from "@/components/app/AppNav";
import { ReconnectBanner } from "@/components/app/ReconnectBanner";
import { ToastProvider } from "@/components/ui/Toast";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const needsReconnect = user.calendarStatus !== "healthy";
  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-1 flex-col">
        <AppNav user={{ name: user.name, email: user.email, slug: user.slug, role: user.role, photoUrl: user.photoUrl }} />
        {needsReconnect ? (
          <Suspense fallback={null}>
            <ReconnectBanner status={user.calendarStatus} />
          </Suspense>
        ) : null}
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          {children}
        </main>
        <footer className="border-t border-border bg-surface py-4 text-center text-xs text-muted">BTC Scheduling · Internal use only</footer>
      </div>
    </ToastProvider>
  );
}
