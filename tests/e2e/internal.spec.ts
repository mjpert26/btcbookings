import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Smoke tests for the internal (employee and admin) UI.
 *
 * Requirements: the app is running and its database contains two sessions whose raw
 * tokens are given in E2E_USER_TOKEN (a regular user who is a team admin of at least one
 * team) and E2E_ADMIN_TOKEN (a global admin). The tests are skipped when either is unset.
 * The interaction tests change data, so run them against a disposable database.
 *
 * E2E_SHOT_DIR (default test-results/shots) receives a full-page screenshot per page.
 */
const USER = process.env.E2E_USER_TOKEN;
const ADMIN = process.env.E2E_ADMIN_TOKEN;
const SHOTS = process.env.E2E_SHOT_DIR ?? "test-results/shots";
mkdirSync(SHOTS, { recursive: true });

test.skip(!USER || !ADMIN, "E2E_USER_TOKEN and E2E_ADMIN_TOKEN are required");

async function signIn(page: Page, token: string) {
  const base = new URL(test.info().project.use.baseURL ?? "http://localhost:3100");
  await page.context().addCookies([{ name: "btc_session", value: token, domain: base.hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
}

/** Navigates and waits until the client bundle has loaded and hydrated. */
async function go(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

/** Clicks a link and waits for the resulting page to load. */
async function follow(page: Page, link: ReturnType<Page["getByRole"]>, url: RegExp) {
  await link.click();
  await page.waitForURL(url);
  await page.waitForLoadState("networkidle");
}

/** Visits a page, fails on server errors or uncaught client errors, and saves a screenshot. */
async function visit(page: Page, url: string, shot: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.goto(url);
  expect(res?.status(), `${url} status`).toBeLessThan(400);
  await expect(page.locator("body")).not.toContainText("Application error");
  await expect(page.locator("body")).not.toContainText("Unhandled Runtime Error");
  await expect(page.locator("main")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(SHOTS, `${shot}.png`), fullPage: true });
  expect(errors, `client errors on ${url}`).toEqual([]);
}

test.describe("signed out", () => {
  test("sign-in page and error codes", async ({ page }) => {
    await visit(page, "/login", "login");
    await expect(page.getByRole("link", { name: "Sign in with Microsoft" })).toHaveAttribute("href", /\/api\/auth\/login\?returnTo=/);
    await visit(page, "/login?error=not_allowed", "login-error");
    await expect(page.getByRole("alert").filter({ hasText: "This account cannot sign in" })).toBeVisible();
    await visit(page, "/login?signedOut=1", "login-signed-out");
    await expect(page.getByRole("status").filter({ hasText: "signed out" })).toBeVisible();
  });

  test("protected pages redirect to sign-in", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("regular user", () => {
  test.beforeEach(async ({ page }) => signIn(page, USER!));

  const pages: [string, string][] = [
    ["/dashboard", "user-dashboard"],
    ["/bookings", "user-bookings"],
    ["/bookings?tab=past", "user-bookings-past"],
    ["/event-types", "user-event-types"],
    ["/event-types/new", "user-event-type-new"],
    ["/availability", "user-availability"],
    ["/teams", "user-teams"],
  ];
  for (const [url, shot] of pages) {
    test(`renders ${url}`, async ({ page }) => visit(page, url, shot));
  }

  test("admin pages are not reachable", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/dashboard\?error=forbidden/);
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Admin" })).toHaveCount(0);
  });

  test("detail pages", async ({ page }) => {
    await go(page, "/bookings");
    await follow(page, page.getByRole("table").getByRole("link").first(), /\/bookings\/[0-9a-f-]{36}/);
    await visit(page, page.url(), "user-booking-detail");
    await expect(page.getByText("Salesforce lead")).toHaveCount(0);

    await go(page, "/event-types");
    await follow(page, page.getByRole("main").getByRole("link", { name: "Intro call" }), /\/event-types\/[0-9a-f-]{36}$/);
    await visit(page, page.url(), "user-event-type-edit");

    await go(page, "/teams");
    await follow(page, page.getByRole("main").getByRole("link", { name: "Spanish Desk" }), /\/teams\/[0-9a-f-]{36}$/);
    await visit(page, page.url(), "user-team-member-view");
  });

  test("availability validation and overrides", async ({ page }) => {
    await go(page, "/availability");
    await page.getByLabel("Monday interval 1 end").fill("08:00");
    await expect(page.getByText("Start time must be before end time").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Save weekly hours" })).toBeDisabled();
    await page.getByLabel("Monday interval 1 end").fill("17:00");
    await page.getByRole("button", { name: "Save weekly hours" }).click();
    await expect(page.getByText("Weekly hours saved.")).toBeVisible();

    const date = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    await page.locator('input[name="date"]').fill(date);
    await page.getByRole("button", { name: "Add override" }).click();
    await expect(page.getByText("Marked unavailable for that date.")).toBeVisible();

    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByText("Booking preferences saved.")).toBeVisible();
  });

  test("create an event type with a question, then a Spanish variant", async ({ page }) => {
    const slug = `e2e-${Date.now().toString(36)}`;
    await go(page, "/event-types/new");
    await page.getByRole("button", { name: "Create event type" }).click();
    await expect(page.getByText("Enter a name.")).toBeVisible();

    await page.locator('input[name="name"]').fill("E2E consultation");
    await page.getByLabel("URL slug").fill(slug);
    await page.getByRole("button", { name: "+ Add question" }).click();
    await page.getByLabel("Label (English)").first().fill("Company name");
    await page.getByLabel("Label (Spanish)").first().fill("Nombre de la empresa");
    await page.getByRole("button", { name: "Create event type" }).click();
    await page.waitForURL(/\/event-types\/[0-9a-f-]{36}\?created=1/);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Event type created")).toBeVisible();
    await expect(page.getByLabel("Key (used in Salesforce mapping)")).toHaveValue("company_name");

    await page.getByRole("button", { name: "Add Spanish variant" }).click();
    await page.waitForURL(/\/variants\?created=1/);
    await page.waitForLoadState("networkidle");
    await visit(page, page.url(), "user-variants");
    await expect(page.getByText("Inherited").first()).toBeVisible();
    await page.getByRole("switch", { name: "Override Location" }).click();
    await expect(page.getByText("Location is now overridden on the variant.")).toBeVisible();
    await expect(page.getByText("Overridden").first()).toBeVisible();
  });

  test("team admin can pause and unpause a member", async ({ page }) => {
    await go(page, "/teams");
    await follow(page, page.getByRole("main").getByRole("link", { name: "Funding Advisors" }), /\/teams\/[0-9a-f-]{36}$/);
    await visit(page, page.url(), "user-team-admin");
    await expect(page.getByText("Skipped by round-robin until reconnected").first()).toBeVisible();
    await page.getByRole("button", { name: "Pause Bob Smith" }).click();
    await expect(page.getByText("Member paused.")).toBeVisible();
    await page.getByRole("button", { name: "Unpause Bob Smith" }).click();
    await expect(page.getByText(/Member is active again|pending onboarding/)).toBeVisible();
    // The pause and unpause are written as admin membership events.
    await expect(page.getByRole("table", { name: "Membership events" }).getByText("admin").first()).toBeVisible();
  });

  test("team admin removes a manual member; queue members have no remove button", async ({ page }) => {
    await go(page, "/teams");
    await follow(page, page.getByRole("main").getByRole("link", { name: "Funding Advisors" }), /\/teams\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("button", { name: "Remove Bob Smith" })).toHaveCount(0);
    await page.getByRole("button", { name: "Remove Carla Diaz" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Remove Carla Diaz from the team?");
    await dialog.getByRole("button", { name: "Remove member" }).click();
    await expect(page.getByText("Member removed from the team.")).toBeVisible();
    await expect(page.getByRole("table", { name: "Team members" }).getByText("carla.diaz@bigthinkcapital.com")).toHaveCount(0);
  });

  test("event type page shows both public links", async ({ page }) => {
    await go(page, "/event-types/e1000000-0000-4000-8000-000000000001");
    const links = page.getByRole("region", { name: "Public links" });
    await expect(links).toContainText(`${process.env.E2E_APP_BASE_URL ?? "http://localhost:3100"}/ana-lopez/intro-call`);
    await expect(links).toContainText("/ana-lopez/intro-call/es");
    await expect(links.getByRole("button", { name: "Copy English link" })).toBeVisible();
    await expect(links.getByRole("button", { name: "Copy Spanish link" })).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "user-event-type-links.png"), fullPage: false });
  });

  test("host can cancel a booking", async ({ page }) => {
    await go(page, "/bookings");
    await follow(page, page.getByRole("table").getByRole("link").first(), /\/bookings\/[0-9a-f-]{36}/);
    await page.getByRole("button", { name: "Cancel booking" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Cancel booking" }).click();
    await dialog.getByLabel("Reason (optional)").fill("Rescheduling with the client by phone.");
    await dialog.getByRole("button", { name: "Cancel booking" }).click();
    // The page re-renders as cancelled, which removes the dialog and the cancel button.
    await expect(page.getByText(/Cancelled by host/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel booking" })).toHaveCount(0);
  });
});

test.describe("admin", () => {
  test.beforeEach(async ({ page }) => signIn(page, ADMIN!));

  const pages: [string, string][] = [
    ["/dashboard", "admin-dashboard"],
    ["/admin", "admin-overview"],
    ["/admin/users", "admin-users"],
    ["/admin/audit", "admin-audit"],
    ["/admin/salesforce/jobs", "admin-sf-jobs"],
    ["/bookings", "admin-bookings"],
  ];
  for (const [url, shot] of pages) {
    test(`renders ${url}`, async ({ page }) => visit(page, url, shot));
  }

  test("team sync: validation, link queue, resolve alert", async ({ page }) => {
    await go(page, "/admin");
    await follow(page, page.getByRole("row", { name: /Funding Advisors/ }).getByRole("link", { name: /^Queues/ }), /\/sync$/);
    await visit(page, page.url(), "admin-team-sync");
    await page.getByLabel("Queue ID").fill("00X123");
    await page.getByRole("button", { name: "Link queue" }).click();
    await expect(page.getByText("Queue IDs start with 00G")).toBeVisible();
    await page.getByLabel("Queue ID").fill("00GVy00000TRvHdMAL");
    await page.getByRole("button", { name: "Link queue" }).click();
    await expect(page.getByText("Queue linked.")).toBeVisible();
    await expect(page.getByText("00GVy00000TRvHdMAL", { exact: true }).first()).toBeVisible();
    // A blocked mass removal can be approved for the next snapshot.
    await page.getByRole("button", { name: "Approve mass removal" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Approve the blocked removals?");
    await page.screenshot({ path: path.join(SHOTS, "admin-team-sync-approve.png"), fullPage: false });
    await dialog.getByRole("button", { name: "Approve and resolve" }).click();
    await expect(page.getByText(/Alert resolved\. The next queue snapshot within 30 minutes/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve mass removal" })).toHaveCount(0);
    // Without N8N_SIGNING_SECRET the backend refuses to call n8n and says why.
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText(/N8N_SIGNING_SECRET|n8n could not be reached|n8n did not accept|Sync requested/)).toBeVisible();
  });

  test("create a team", async ({ page }) => {
    await go(page, "/admin");
    await follow(page, page.getByRole("link", { name: "New team" }), /\/admin\/teams\/new$/);
    await visit(page, page.url(), "admin-team-new");
    await page.getByRole("button", { name: "Create team" }).click();
    await expect(page.getByText("Enter a name.")).toBeVisible();
    const name = `E2E Team ${Date.now().toString(36)}`;
    await page.getByLabel("Team name").fill(name);
    await expect(page.getByLabel("URL slug")).toHaveValue(/^e2e-team-/);
    await page.getByRole("button", { name: "Create team" }).click();
    await page.waitForURL(/\/teams\/[0-9a-f-]{36}\?created=1$/);
    await expect(page.getByText("Team created")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await page.getByLabel("Add member by email").fill("new.person@bigthinkcapital.com");
    await page.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByText(/new\.person@bigthinkcapital\.com added/)).toBeVisible();
  });

  test("team slack: dry run, preview", async ({ page }) => {
    await go(page, "/admin");
    await follow(page, page.getByRole("row", { name: /Funding Advisors/ }).getByRole("link", { name: /^Slack/ }), /\/slack$/);
    await visit(page, page.url(), "admin-team-slack");
    await expect(page.getByText("DRY RUN").first()).toBeVisible();
    await expect(page.getByText("/invite @BTC Scheduler")).toBeVisible();
    await follow(page, page.getByRole("link", { name: /^Preview/ }).first(), /preview=/);
    // The preview reads the channel's real members from Slack; without a bot token it says so.
    const preview = page.getByRole("region", { name: /^Preview for/ });
    await expect(preview).toBeVisible();
    await expect(preview.getByText(/Would add|Slack is not configured/).first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "admin-team-slack-preview.png"), fullPage: true });
    await page.getByRole("button", { name: "Check health" }).first().click();
    await expect(page.getByText(/Channel is healthy|Slack is not configured|The bot is not in this channel|Slack reported|Slack did not confirm/).first()).toBeVisible();
    await page.getByRole("switch", { name: /Dry run for/ }).first().click();
    await expect(page.getByText("Dry run is off.")).toBeVisible();
  });

  test("salesforce settings and job retry", async ({ page }) => {
    await go(page, "/event-types/e1000000-0000-4000-8000-000000000003");
    await follow(page, page.getByRole("link", { name: "Salesforce settings" }), /\/salesforce$/);
    await visit(page, page.url(), "admin-sf-settings");
    await page.getByLabel("Lead source (ISO)").fill("bad");
    await page.getByRole("button", { name: "Save Salesforce settings" }).click();
    await expect(page.getByText("Account IDs start with 001")).toBeVisible();
    await page.getByLabel("Lead source (ISO)").fill("0015e00000AbCdEAAV");
    const task = page.getByRole("switch", { name: "Create a Meeting Booked Task" });
    await expect(task).toHaveAttribute("aria-checked", "false");
    await task.click();
    await page.getByRole("button", { name: "Save Salesforce settings" }).click();
    await expect(page.getByText(/Saved\./)).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("switch", { name: "Create a Meeting Booked Task" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("switch", { name: "Create a Meeting Booked note" })).toHaveAttribute("aria-checked", "false");

    await go(page, "/admin/salesforce/jobs?status=problem");
    await page.getByText("8 attempts").first().click();
    await expect(page.getByText("HTTP 502").first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "admin-sf-jobs-history.png"), fullPage: true });
    const retry = page.getByRole("button", { name: "Retry" });
    if (await retry.count()) {
      await retry.first().click();
      await expect(page.getByText("Job queued for retry.")).toBeVisible();
    }
  });

  test("variant salesforce inheritance page", async ({ page }) => {
    await visit(page, "/admin/event-types/e1000000-0000-4000-8000-000000000002/salesforce", "admin-sf-variant");
    await expect(page.getByRole("switch", { name: "Override Salesforce settings" })).toBeVisible();
  });

  test("overview counts link to the problem lists", async ({ page }) => {
    await go(page, "/admin");
    await expect(page.getByText("Dead Salesforce lead jobs")).toBeVisible();
    await expect(page.getByText("Broken Outlook connections", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("table", { name: "Broken Outlook connections" }).getByText("Bob Smith")).toBeVisible();
  });

  test("disconnect Outlook from the dashboard", async ({ page }) => {
    await go(page, "/dashboard");
    await page.getByRole("button", { name: "Disconnect Outlook" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Disconnect your Outlook calendar?");
    await page.screenshot({ path: path.join(SHOTS, "admin-dashboard-disconnect.png"), fullPage: false });
    await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("Outlook disconnected.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Reconnect Outlook" }).first()).toBeVisible();
  });
});

test.describe("not found", () => {
  test("unknown URLs show the branded page", async ({ page }) => {
    const res = await page.goto("/no/such/page/here");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("img", { name: "Big Think Capital" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Employee sign-in" })).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "not-found.png"), fullPage: true });
  });
});

test.describe("mobile @mobile", () => {
  test("navigation disclosure @mobile", async ({ page }) => {
    await signIn(page, USER!);
    await go(page, "/dashboard");
    const toggle = page.getByRole("button", { name: "Open menu" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({ path: path.join(SHOTS, "mobile-nav-open.png"), fullPage: false });
    await follow(page, page.getByRole("navigation", { name: "Main mobile" }).getByRole("link", { name: "Availability" }), /\/availability/);
    await page.screenshot({ path: path.join(SHOTS, "mobile-availability.png"), fullPage: true });
  });

  test("mobile sign-in @mobile", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(SHOTS, "mobile-login.png"), fullPage: true });
  });
});
