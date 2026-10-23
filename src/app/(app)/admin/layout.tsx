import { requireCapability } from "@/server/auth/session";
import { AdminNav } from "./AdminNav";

/**
 * Every page under /admin requires at least the audit.read capability (admins and managers).
 * Pages in the (admin-only) route group additionally require a global admin in their own
 * layout; the audit log is the only page managers can open. These checks run on the server for
 * each request.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCapability("audit.read");
  return (
    <div>
      <AdminNav role={user.role} />
      {children}
    </div>
  );
}
