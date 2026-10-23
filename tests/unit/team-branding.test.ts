import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  accessibleAccent,
  contrastRatio,
  DEFAULT_PAGE_SETTINGS,
  parsePageSettings,
  resolvePageSettings,
  toStoredPageSettings,
} from "@/server/teams/page-settings";
import { LOGO_MAX_BYTES, LogoValidationError, sniffImageType, validateLogo } from "@/server/teams/logo";
import { buildPartnerBranding, teamLogoPath } from "@/server/teams/branding";
import { accentStyle, eventDetails, headerParts, logoBox, visibleHosts, type PartnerDisplay } from "@/components/public/branding";
import { brand } from "@/theme/brand";
import { jpegBytes, pngBytes, svgBytes, webpBytes } from "../helpers/images";

const TEAM_ID = "6f1c1d1e-0000-4000-8000-000000000001";

describe("page settings validation", () => {
  it("accepts every documented field", () => {
    const v = parsePageSettings({
      displayName: "  Acme Funding  ",
      accentColor: "#0b5a91",
      heading: "Talk to Acme",
      intro: "Line one\nLine two",
      showHostPhoto: false,
      showHostName: true,
      showBtcLogo: false,
      showDuration: true,
      showDescription: false,
      showPartnerLogo: true,
    });
    expect(v.displayName).toBe("Acme Funding");
    expect(v.accentColor).toBe("#0B5A91");
    expect(v.intro).toBe("Line one\nLine two");
  });

  it("rejects unknown keys", () => {
    expect(() => parsePageSettings({ showLogo: true })).toThrow(ZodError);
    expect(() => parsePageSettings({ displayName: "A", css: "body{}" })).toThrow(ZodError);
  });

  it("enforces lengths, colors, types and plain text", () => {
    expect(() => parsePageSettings({ displayName: "x".repeat(81) })).toThrow(ZodError);
    expect(() => parsePageSettings({ displayName: "x".repeat(80) })).not.toThrow();
    expect(() => parsePageSettings({ heading: "x".repeat(121) })).toThrow(ZodError);
    expect(() => parsePageSettings({ intro: "x".repeat(1001) })).toThrow(ZodError);
    expect(() => parsePageSettings({ intro: "x".repeat(1000) })).not.toThrow();
    expect(() => parsePageSettings({ accentColor: "red" })).toThrow(ZodError);
    expect(() => parsePageSettings({ accentColor: "#fff" })).toThrow(ZodError);
    expect(() => parsePageSettings({ accentColor: "#0D66A5; background:url(x)" })).toThrow(ZodError);
    expect(() => parsePageSettings({ showHostPhoto: "false" })).toThrow(ZodError);
    expect(() => parsePageSettings({ displayName: "Line\nbreak" })).toThrow(ZodError);
    expect(() => parsePageSettings({ intro: "bell\u0007" })).toThrow(ZodError);
    expect(() => parsePageSettings({ displayName: "   " })).toThrow(ZodError);
  });

  it("applies defaults when reading and ignores bad stored values", () => {
    expect(resolvePageSettings({})).toEqual(DEFAULT_PAGE_SETTINGS);
    expect(resolvePageSettings(null)).toEqual(DEFAULT_PAGE_SETTINGS);
    const r = resolvePageSettings({ showHostName: false, accentColor: "nope", extra: 1, heading: "Hi" });
    expect(r.showHostName).toBe(false);
    expect(r.accentColor).toBeNull();
    expect(r.heading).toBe("Hi");
    expect(r.showBtcLogo).toBe(true);
    expect(r).not.toHaveProperty("extra");
  });

  it("stores only set text fields plus every toggle", () => {
    const stored = toStoredPageSettings({ ...DEFAULT_PAGE_SETTINGS, heading: "Hello", showDuration: false });
    expect(stored).toEqual({
      heading: "Hello",
      showPartnerLogo: true,
      showBtcLogo: true,
      showHostPhoto: true,
      showHostName: true,
      showDuration: false,
      showDescription: true,
    });
    expect(parsePageSettings(stored)).toEqual(stored);
  });
});

describe("accent contrast", () => {
  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#0D66A5", "#FFFFFF")).toBeCloseTo(6.07, 1);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
  });

  it("keeps an accent that reaches 4.5:1 against white", () => {
    const a = accessibleAccent("#b91c1c");
    expect(a).toMatchObject({ color: "#B91C1C", fellBack: false });
    expect(a.ratio).toBeGreaterThanOrEqual(4.5);
    expect(a.hover).not.toBe(a.color);
  });

  it("falls back to the brand color when contrast is too low", () => {
    for (const light of ["#FFFF00", "#22A4DC", "#777777", "#FFFFFF"]) {
      const a = accessibleAccent(light);
      expect(a.fellBack).toBe(true);
      expect(a.color).toBe(brand.colors.primary);
      expect(a.ratio).toBeLessThan(4.5);
    }
  });

  it("uses the brand color when no accent or an invalid one is set", () => {
    expect(accessibleAccent(null)).toMatchObject({ color: brand.colors.primary, fellBack: false, ratio: null });
    expect(accessibleAccent("javascript:alert(1)")).toMatchObject({ color: brand.colors.primary, fellBack: false });
  });
});

describe("logo validation", () => {
  it("detects PNG, JPEG and WebP by magic bytes and reads dimensions", () => {
    expect(validateLogo(pngBytes(200, 80), "image/png")).toMatchObject({ contentType: "image/png", width: 200, height: 80 });
    expect(validateLogo(jpegBytes(320, 120), "image/jpeg")).toMatchObject({ contentType: "image/jpeg", width: 320, height: 120 });
    expect(validateLogo(webpBytes(400, 100), "image/webp")).toMatchObject({ contentType: "image/webp", width: 400, height: 100 });
    expect(validateLogo(jpegBytes(), "image/jpg").contentType).toBe("image/jpeg");
    expect(validateLogo(pngBytes()).contentType).toBe("image/png");
  });

  it("computes a sha256 of the bytes", () => {
    const v = validateLogo(pngBytes());
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateLogo(pngBytes()).sha256).toBe(v.sha256);
    expect(validateLogo(pngBytes(201, 80)).sha256).not.toBe(v.sha256);
  });

  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof LogoValidationError ? e.code : "other";
    }
    return "none";
  };

  it("rejects SVG whatever it is declared as", () => {
    expect(code(() => validateLogo(svgBytes(), "image/svg+xml"))).toBe("unsupported_type");
    expect(code(() => validateLogo(svgBytes(), "image/png"))).toBe("unsupported_type");
    expect(code(() => validateLogo(svgBytes()))).toBe("unsupported_type");
    expect(sniffImageType(svgBytes())).toBeNull();
  });

  it("rejects a declared type that does not match the contents", () => {
    expect(code(() => validateLogo(pngBytes(), "image/jpeg"))).toBe("type_mismatch");
    expect(code(() => validateLogo(jpegBytes(), "image/webp"))).toBe("type_mismatch");
    expect(code(() => validateLogo(pngBytes(), "image/svg+xml"))).toBe("unsupported_type");
  });

  it("rejects empty, oversized, truncated and huge images", () => {
    expect(code(() => validateLogo(new Uint8Array(0)))).toBe("empty");
    expect(code(() => validateLogo(pngBytes(10, 10, LOGO_MAX_BYTES + 1)))).toBe("too_large");
    expect(code(() => validateLogo(pngBytes(10, 10, LOGO_MAX_BYTES)))).toBe("none");
    expect(code(() => validateLogo(pngBytes().subarray(0, 12)))).toBe("corrupt");
    expect(code(() => validateLogo(pngBytes(5000, 10)))).toBe("too_many_pixels");
    expect(code(() => validateLogo(new TextEncoder().encode("GIF89a........")))).toBe("unsupported_type");
  });
});

describe("partner branding", () => {
  const row = { id: TEAM_ID, name: "Acme ISO", page_settings: {}, logo_sha256: null, logo_width: null, logo_height: null };

  it("falls back to the team name and brand color", () => {
    const b = buildPartnerBranding(row);
    expect(b).toMatchObject({ displayName: "Acme ISO", logoUrl: null, accentColor: brand.colors.primary, showBtcLogo: true });
  });

  it("uses the display name, a versioned logo URL and a contrast-safe accent", () => {
    const sha = "a".repeat(64);
    const b = buildPartnerBranding({ ...row, page_settings: { displayName: "Acme", accentColor: "#FFEE00" }, logo_sha256: sha, logo_width: 400, logo_height: 100 });
    expect(b.displayName).toBe("Acme");
    expect(b.logoUrl).toBe(teamLogoPath(TEAM_ID, sha));
    expect(b.logoUrl).toBe(`/api/public/team-logo/${TEAM_ID}?v=aaaaaaaaaaaaaaaa`);
    expect(b.accentColor).toBe(brand.colors.primary);
  });
});

describe("public display rules", () => {
  const partner = (over: Partial<PartnerDisplay> = {}): PartnerDisplay => ({
    displayName: "Acme",
    logoUrl: "/api/public/team-logo/x?v=1",
    logoWidth: 400,
    logoHeight: 100,
    accentColor: "#B91C1C",
    accentHover: "#A31919",
    heading: null,
    intro: null,
    showHostPhoto: true,
    showHostName: true,
    showBtcLogo: true,
    showDuration: true,
    showDescription: true,
    showPartnerLogo: true,
    ...over,
  });
  const hosts = [
    { name: "Ana Host", photoUrl: "https://example.supabase.co/a.jpg" },
    { name: "Ben Host", photoUrl: null },
  ];

  it("leaves individual pages unchanged", () => {
    expect(accentStyle(null)).toBeUndefined();
    expect(headerParts(null)).toEqual({ btcLogo: true, partnerLogo: null, partnerName: null });
    expect(eventDetails(null)).toEqual({ duration: true, description: true });
    expect(visibleHosts(hosts, null)).toEqual([
      { name: "Ana Host", photoUrl: hosts[0].photoUrl, showAvatar: true },
      { name: "Ben Host", photoUrl: null, showAvatar: true },
    ]);
  });

  it("applies the accent and header settings", () => {
    expect(accentStyle(partner())).toEqual({ "--btc-primary": "#B91C1C", "--btc-primary-hover": "#A31919" });
    expect(headerParts(partner())).toEqual({ btcLogo: true, partnerLogo: { src: "/api/public/team-logo/x?v=1", width: 160, height: 40 }, partnerName: "Acme" });
    expect(headerParts(partner({ showPartnerLogo: false, showBtcLogo: false }))).toEqual({ btcLogo: false, partnerLogo: null, partnerName: "Acme" });
    expect(headerParts(partner({ logoUrl: null })).partnerLogo).toBeNull();
  });

  it("hides duration and description", () => {
    expect(eventDetails(partner({ showDuration: false, showDescription: false }))).toEqual({ duration: false, description: false });
  });

  it("hides host names and photos without leaking names through initials", () => {
    expect(visibleHosts(hosts, partner({ showHostName: false, showHostPhoto: false }))).toEqual([]);
    expect(visibleHosts(hosts, partner({ showHostName: false }))).toEqual([{ name: null, photoUrl: hosts[0].photoUrl, showAvatar: true }]);
    expect(visibleHosts(hosts, partner({ showHostPhoto: false }))).toEqual([
      { name: "Ana Host", photoUrl: null, showAvatar: false },
      { name: "Ben Host", photoUrl: null, showAvatar: false },
    ]);
  });

  it("sizes logos to 40px tall within 200px", () => {
    expect(logoBox(400, 100)).toEqual({ width: 160, height: 40 });
    expect(logoBox(2000, 100)).toEqual({ width: 200, height: 10 });
    expect(logoBox(null, null)).toEqual({ width: 40, height: 40 });
  });
});
