import { requireAdmin } from "@/server/auth/session";

/** Admin pages other than the audit log: global admins only. Managers are redirected. */
export default async function AdminOnlyLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
