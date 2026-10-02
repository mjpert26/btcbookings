import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { CopyButton } from "@/components/app/CopyButton";

export type PublicLink = {
  language: "en" | "es";
  label: string;
  url: string;
  /** "active", "off" (the page exists but is turned off) or "missing" (no variant yet). */
  state: "active" | "off" | "missing";
  current: boolean;
};

const STATE_HINT: Record<PublicLink["state"], string> = {
  active: "Live",
  off: "Turned off: the link shows a not found page until bookings are turned on.",
  missing: "No Spanish variant yet: the link shows a not found page until one is added and turned on.",
};

/** Public booking URLs of an event type family (English page and Spanish variant), with copy buttons. */
export function PublicLinks({ links }: { links: PublicLink[] }) {
  return (
    <Card className="mb-6" aria-labelledby="links-h">
      <CardHeader id="links-h" title="Public links" description="Share these with invitees. Each language variant has its own URL." />
      <CardBody flush>
        <ul className="divide-y divide-border">
          {links.map((l) => (
            <li key={l.language} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-navy">
                  {l.label}
                  <Badge tone={l.language === "es" ? "warning" : "primary"}>{l.language.toUpperCase()}</Badge>
                  {l.current ? <span className="text-xs font-normal text-muted">(this page)</span> : null}
                </p>
                <p className="mt-0.5 break-all font-mono text-xs text-ink">{l.url}</p>
                {l.state !== "active" ? <p className="mt-0.5 text-xs text-warning">{STATE_HINT[l.state]}</p> : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <CopyButton text={l.url} label={`Copy ${l.language === "es" ? "Spanish" : "English"} link`} />
                {l.state === "active" ? (
                  <a href={l.url} target="_blank" rel="noopener" className="inline-flex h-8 items-center rounded-md px-3 text-sm font-semibold text-primary hover:bg-primary/10">
                    Open<span className="sr-only"> {l.label}</span>
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
