import { ButtonLink } from "@/components/ui/Button";

export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-lg rounded-brand border border-border bg-surface p-8 text-center shadow-sm">
      <h1 className="text-xl font-bold">Not found</h1>
      <p className="mt-2 text-sm text-muted">This page does not exist, or you do not have access to it.</p>
      <div className="mt-6 flex justify-center">
        <ButtonLink href="/dashboard">Go to dashboard</ButtonLink>
      </div>
    </div>
  );
}
