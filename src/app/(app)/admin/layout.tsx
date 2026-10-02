import { requireAdmin } from "@/server/auth/session";
import { AdminNav } from "./AdminNav";

/** Every page under /admin requires a global admin; this check runs on the server for each request. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div>
      <AdminNav />
      {children}
    </div>
  );
}
