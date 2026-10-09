import type { Metadata } from "next";
import { requireAdmin } from "@/server/auth/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { ImportForm } from "./ImportForm";

export const metadata: Metadata = { title: "Import from Calendly" };
// Large snapshots run several thousand statements in one transaction.
export const maxDuration = 300;

export default async function ImportPage() {
  await requireAdmin();
  return (
    <>
      <PageHeader
        title="Import from Calendly"
        description="Copies Calendly members, team pages, booking pages and upcoming meetings. Nothing is changed in Calendly and nobody is notified: imported meetings never send emails, write to Outlook or create Salesforce leads. Re-running the import is safe."
      />
      <Card>
        <CardBody>
          <ImportForm />
        </CardBody>
      </Card>
    </>
  );
}
