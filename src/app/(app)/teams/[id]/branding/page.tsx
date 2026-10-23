import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { isUuid } from "@/server/ui/form";
import { getTeamBrandingForEdit, TeamBrandingError } from "@/server/teams/branding";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ButtonLink } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Toast";
import { ActionButton } from "@/components/app/ActionButton";
import { formatDateTime } from "@/lib/format";
import { removeLogoAction, saveBrandingAction, uploadLogoAction } from "./_actions";
import { BrandingForm, LogoUploadForm } from "./BrandingForm";

export const metadata: Metadata = { title: "Partner branding" };

/** /teams/[id]/branding: how the partner's public booking pages look. Team admins and admins only. */
export default async function TeamBrandingPage({ params }: PageProps<"/teams/[id]/branding">) {
  const user = await requireUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();

  let data: Awaited<ReturnType<typeof getTeamBrandingForEdit>>;
  try {
    data = await getTeamBrandingForEdit(user, id);
  } catch (err) {
    if (err instanceof TeamBrandingError && err.code === "not_found") notFound();
    if (err instanceof TeamBrandingError && err.code === "forbidden") {
      return (
        <>
          <PageHeader breadcrumbs={[{ href: "/teams", label: "Teams" }, { href: `/teams/${id}`, label: "Team" }]} title="Partner branding" />
          <Notice tone="warning" title="Team admins only">
            Only this team&apos;s admins and global admins can change how its public pages look.
          </Notice>
        </>
      );
    }
    throw err;
  }
  const { team, settings, logo } = data;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { href: "/teams", label: "Teams" },
          { href: `/teams/${team.id}`, label: team.name },
        ]}
        title="Partner branding"
        description="Customize how this partner's public booking pages look. Individual booking pages are not affected."
        actions={
          <ButtonLink href={`/t/${team.slug}`} variant="secondary" size="sm" target="_blank" rel="noopener">
            Open public page
          </ButtonLink>
        }
      />

      <Card className="mb-6" aria-labelledby="logo-h">
        <CardHeader id="logo-h" title="Logo" description="Shown in the header of the partner's public pages." />
        <CardBody className="space-y-4">
          {logo ? (
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex h-20 min-w-32 items-center justify-center rounded-lg border border-border bg-white p-3">
                {/* Served by /api/public/team-logo with the stored type. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logo.url} alt={`${team.name} logo`} className="max-h-14 w-auto object-contain" />
              </div>
              <div className="text-sm text-muted">
                <p>
                  {logo.contentType.replace("image/", "").toUpperCase()}, {Math.ceil(logo.byteSize / 1024)} KB
                  {logo.width && logo.height ? `, ${logo.width} × ${logo.height} px` : ""}
                </p>
                <p>Updated {formatDateTime(logo.updatedAt, user.timezone)}</p>
              </div>
              <ActionButton action={removeLogoAction.bind(null, team.id)} variant="ghost" size="sm" pendingLabel="Removing…">
                Remove logo
              </ActionButton>
            </div>
          ) : (
            <p className="text-sm text-muted">No logo uploaded. Public pages show the partner name only.</p>
          )}
          <LogoUploadForm action={uploadLogoAction.bind(null, team.id)} hasLogo={Boolean(logo)} />
        </CardBody>
      </Card>

      <Card aria-labelledby="settings-h">
        <CardHeader id="settings-h" title="Page settings" description="Every change is recorded in the audit log." />
        <CardBody>
          <BrandingForm action={saveBrandingAction.bind(null, team.id)} initial={settings} teamName={team.name} logoUrl={logo?.url ?? null} />
        </CardBody>
      </Card>

      <p className="mt-6 text-sm text-muted">
        <Link href={`/teams/${team.id}`} className="font-semibold text-primary hover:underline">
          Back to {team.name}
        </Link>
      </p>
    </>
  );
}
