import type { Metadata } from "next";
import { requireAdmin } from "@/server/auth/session";
import { bookField, getHomeRoutingForEdit, type PageOption } from "@/server/home/admin";
import { RENEWAL_BOOKS, MAX_EXCLUDED_OWNER_EMAILS } from "@/lib/home-routing";
import { formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Toast";
import { ActionForm } from "@/components/ui/Form";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { saveHomeRoutingAction } from "../../_actions/home-routing";
import { HomeRoutingTester } from "./HomeRoutingTester";

export const metadata: Metadata = { title: "Home page" };
export const dynamic = "force-dynamic";

const MODE: Record<string, string> = { round_robin: "round robin", collective: "collective", individual: "personal" };

function optionLabel(o: PageOption): string {
  const owner = o.isTeam ? `Team ${o.ownerName}` : o.ownerName;
  const languages = o.languages.length ? ` [${o.languages.map((l) => l.toUpperCase()).join(", ")}]` : "";
  return `${owner} · ${o.name} (${MODE[o.schedulingMode] ?? o.schedulingMode})${languages} · ${o.isActive ? "Active" : "Paused"}`;
}

function options(list: PageOption[], selected: string | null): SelectOption[] {
  const out = list.map((o) => ({ value: o.id, label: optionLabel(o) }));
  // A saved page that no longer qualifies stays visible so the admin sees what is stored.
  if (selected && !list.some((o) => o.id === selected)) out.unshift({ value: selected, label: "Unavailable booking page (choose another)" });
  return out;
}

/**
 * Admin > Home page: where the public home page sends visitors after the Salesforce lookup,
 * and which Salesforce owners never count as an account manager.
 */
export default async function HomeRoutingPage() {
  const user = await requireAdmin();
  const { state, newBusinessOptions, renewalOptions } = await getHomeRoutingForEdit(user);
  const paused = (id: string | null) => !!id && renewalOptions.some((o) => o.id === id && !o.isActive);
  const anyPaused = [state.newBusinessEventTypeId, state.renewalDefaultEventTypeId, ...Object.values(state.renewalBooks)].some(paused);

  return (
    <>
      <PageHeader
        title="Home page"
        description="Visitors enter their email on the home page. The app looks it up in Salesforce through n8n and opens the right booking page: their account manager, their renewal book, or the next available advisor."
      />
      <div className="space-y-6">
        <Notice tone="info">
          Every page chosen here must be active, and the people on it must have Outlook connected; otherwise the visitor sees no times. When the account
          manager has no bookable page, the visitor goes to the new-business page. The rules are described in docs/home-page.md.
        </Notice>
        {anyPaused ? <Notice tone="warning">A page chosen here is paused. Visitors routed to it go to the next option instead.</Notice> : null}

        <Card aria-labelledby="home-routing-pages">
          <CardHeader
            id="home-routing-pages"
            title="Booking pages"
            description={
              state.updatedAt
                ? `Last saved by ${state.updatedByName ?? "a former user"}, ${formatDateTime(state.updatedAt, user.timezone)}.`
                : "Not saved yet."
            }
          />
          <CardBody>
            <ActionForm action={saveHomeRoutingAction} aria-label="Home page routing" className="space-y-6">
              <Select
                name="newBusinessEventTypeId"
                label="New-business page"
                hint="Team round-robin or collective page for new applicants and for anyone the lookup cannot place. The home page's New here? button opens it. Leave empty to hide that button."
                options={options(newBusinessOptions, state.newBusinessEventTypeId)}
                placeholder="None"
                defaultValue={state.newBusinessEventTypeId ?? ""}
              />

              <fieldset className="space-y-4">
                <legend className="text-sm font-semibold text-navy">Renewal pages</legend>
                <p className="text-xs text-muted">
                  For customers with a funded deal or an open renewal opportunity, by the renewal book on their Salesforce account. A book without a page uses
                  the default. When the renewal opportunity&apos;s owner or renewal closer hosts the renewal page, the visitor books with that person directly.
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  {RENEWAL_BOOKS.map((book) => (
                    <Select
                      key={book}
                      name={bookField(book)}
                      label={book}
                      options={options(renewalOptions, state.renewalBooks[book] ?? null)}
                      placeholder="Use the default renewal page"
                      defaultValue={state.renewalBooks[book] ?? ""}
                    />
                  ))}
                  <Select
                    name="renewalDefaultEventTypeId"
                    label="Default renewal page"
                    hint="Used for other books and when a book's page is not set or paused. Leave empty to send renewals to the new-business page."
                    options={options(renewalOptions, state.renewalDefaultEventTypeId)}
                    placeholder="None"
                    defaultValue={state.renewalDefaultEventTypeId ?? ""}
                  />
                </div>
              </fieldset>

              <Textarea
                name="excludedOwnerEmails"
                label="Excluded Salesforce owners"
                hint={`One email per line, at most ${MAX_EXCLUDED_OWNER_EMAILS}. These owners (shared, queue-like or integration users) never count as a visitor's account manager.`}
                rows={8}
                spellCheck={false}
                defaultValue={state.excludedOwnerEmails.join("\n")}
                className="font-mono text-xs"
              />
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>

        <Card aria-labelledby="home-routing-test">
          <CardHeader
            id="home-routing-test"
            title="Test an email"
            description="Runs the same Salesforce lookup and rules as the home page and shows where that visitor would go. Nothing is changed, booked or sent; the audit log records that a test ran, without the email."
          />
          <CardBody>
            <HomeRoutingTester />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
