import type { Metadata } from "next";
import { requireAdmin } from "@/server/auth/session";
import { env } from "@/server/env";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { createTeamAction } from "../../_actions/sync";
import { CreateTeamForm } from "./CreateTeamForm";

export const metadata: Metadata = { title: "New team" };

export default async function NewTeamPage() {
  await requireAdmin();
  return (
    <>
      <PageHeader
        breadcrumbs={[{ href: "/admin", label: "Admin" }]}
        title="New team"
        description="Teams own round-robin and collective booking pages. After creating the team, add members or link Salesforce Queues, then create its event types."
      />
      <Card className="max-w-3xl">
        <CardBody>
          <CreateTeamForm action={createTeamAction} baseUrl={env().APP_BASE_URL.replace(/\/$/, "")} />
        </CardBody>
      </Card>
    </>
  );
}
