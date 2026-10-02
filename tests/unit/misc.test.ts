import { describe, expect, it } from "vitest";
import { backoffSeconds } from "@/server/jobs/queue";
import { slugify, isReservedSlug } from "@/server/auth/slug";
import { safeReturnTo } from "@/server/http/redirects";
import { classifyTokenError } from "@/server/auth/entra";
import { windowsToIana } from "@/server/graph/timezones";

describe("backoff", () => {
  it("grows exponentially and caps at one hour", () => {
    const max = () => 1;
    expect(backoffSeconds(1, max)).toBe(30);
    expect(backoffSeconds(2, max)).toBe(60);
    expect(backoffSeconds(5, max)).toBe(480);
    expect(backoffSeconds(30, max)).toBe(3600);
    expect(backoffSeconds(1, () => 0)).toBe(15);
  });
});

describe("slugify", () => {
  it("normalizes names", () => {
    expect(slugify("Mike Perticone")).toBe("mike-perticone");
    expect(slugify("José Núñez")).toBe("jose-nunez");
    expect(slugify("  ---  ")).toBe("user");
    expect(isReservedSlug("admin")).toBe(true);
  });
});

describe("safeReturnTo", () => {
  it("blocks open redirects", () => {
    expect(safeReturnTo("/dashboard/bookings")).toBe("/dashboard/bookings");
    expect(safeReturnTo("https://evil.example")).toBe("/dashboard");
    expect(safeReturnTo("//evil.example")).toBe("/dashboard");
    expect(safeReturnTo("/\\evil.example")).toBe("/dashboard");
    expect(safeReturnTo(null)).toBe("/dashboard");
    expect(safeReturnTo("/\t/evil.example")).toBe("/dashboard");
    expect(safeReturnTo("/%09/evil.example")).toBe("/%09/evil.example");
    expect(safeReturnTo("/\n/evil.example")).toBe("/dashboard");
    expect(safeReturnTo("/bookings?tab=past#x")).toBe("/bookings?tab=past#x");
  });
});

describe("classifyTokenError", () => {
  it("treats revoked consent and invalid_grant as permanent", () => {
    expect(classifyTokenError(400, { error: "invalid_grant", error_description: "AADSTS70000: revoked" }).permanent).toBe(true);
    expect(classifyTokenError(400, { error: "interaction_required" }).permanent).toBe(true);
    expect(classifyTokenError(400, { error: "invalid_request", error_description: "AADSTS65001: consent" }).permanent).toBe(true);
  });
  it("treats outages as transient", () => {
    expect(classifyTokenError(503, { error: "temporarily_unavailable" }).permanent).toBe(false);
    expect(classifyTokenError(500, {}).permanent).toBe(false);
  });
});

describe("windowsToIana", () => {
  it("maps Windows zones", () => {
    expect(windowsToIana("Eastern Standard Time")).toBe("America/New_York");
    expect(windowsToIana("Pacific Standard Time")).toBe("America/Los_Angeles");
    expect(windowsToIana("America/Chicago")).toBe("America/Chicago");
    expect(windowsToIana("Mars Standard Time")).toBe("America/New_York");
  });
});
