import type { CSSProperties } from "react";
import type { PartnerBranding } from "@/server/teams/branding";

/**
 * Display decisions for partner-branded public pages. Pure functions, so the rules for what a
 * partner hides are unit-tested without rendering. Individual (non-team) pages pass no
 * partner and are unchanged.
 */

export type PartnerDisplay = Pick<
  PartnerBranding,
  | "displayName"
  | "logoUrl"
  | "logoWidth"
  | "logoHeight"
  | "accentColor"
  | "accentHover"
  | "heading"
  | "intro"
  | "showHostPhoto"
  | "showHostName"
  | "showBtcLogo"
  | "showDuration"
  | "showDescription"
  | "showPartnerLogo"
>;

/** Overrides the brand color tokens for the page so buttons, links and focus rings use the accent. */
export function accentStyle(partner: PartnerDisplay | null | undefined): CSSProperties | undefined {
  if (!partner) return undefined;
  return { "--btc-primary": partner.accentColor, "--btc-primary-hover": partner.accentHover } as CSSProperties;
}

/** What the page header shows. */
export function headerParts(partner: PartnerDisplay | null | undefined): {
  btcLogo: boolean;
  partnerLogo: { src: string; width: number; height: number } | null;
  partnerName: string | null;
} {
  if (!partner) return { btcLogo: true, partnerLogo: null, partnerName: null };
  const partnerLogo = partner.showPartnerLogo && partner.logoUrl ? { src: partner.logoUrl, ...logoBox(partner.logoWidth, partner.logoHeight) } : null;
  return { btcLogo: partner.showBtcLogo, partnerLogo, partnerName: partner.displayName };
}

/** Rendered size of the partner logo: 40px tall, at most 200px wide, keeping the aspect ratio. */
export function logoBox(width: number | null, height: number | null, targetHeight = 40, maxWidth = 200): { width: number; height: number } {
  if (!width || !height) return { width: targetHeight, height: targetHeight };
  const w = Math.round((width / height) * targetHeight);
  if (w <= maxWidth) return { width: Math.max(1, w), height: targetHeight };
  return { width: maxWidth, height: Math.max(1, Math.round((height / width) * maxWidth)) };
}

/** Which event details a page shows. */
export function eventDetails(partner: PartnerDisplay | null | undefined): { duration: boolean; description: boolean } {
  return { duration: partner?.showDuration ?? true, description: partner?.showDescription ?? true };
}

/**
 * Hosts as shown to the invitee. A hidden name is removed entirely (the photo alt text then
 * stays generic); a hidden photo is not replaced by initials, which would reveal the name.
 */
export function visibleHosts<H extends { name: string; photoUrl: string | null }>(
  hosts: H[],
  partner: PartnerDisplay | null | undefined,
): { name: string | null; photoUrl: string | null; showAvatar: boolean }[] {
  const showName = partner?.showHostName ?? true;
  const showPhoto = partner?.showHostPhoto ?? true;
  if (!showName && !showPhoto) return [];
  return hosts
    .map((h) => ({
      name: showName ? h.name : null,
      photoUrl: showPhoto ? h.photoUrl : null,
      // Without a name, only a real photo is shown (initials would reveal the name).
      showAvatar: showPhoto && (showName || Boolean(h.photoUrl)),
    }))
    .filter((h) => h.name !== null || h.showAvatar);
}
