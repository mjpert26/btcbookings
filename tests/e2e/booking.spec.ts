import { expect, test, type Page } from "@playwright/test";

/** Picks the first date with availability and its first time. Advances months if needed. */
async function pickFirstSlot(page: Page, timesRegion: RegExp) {
  const available = page.getByRole("button", { name: /\d{4}, (times available|con horarios disponibles)$/ });
  await expect(page.getByText(/Loading available times|Cargando horarios/)).toHaveCount(0, { timeout: 30_000 });
  await expect(available.first()).toBeVisible({ timeout: 30_000 });
  await available.first().click();
  const times = page.getByRole("region", { name: timesRegion });
  await times.getByRole("button").first().click();
}

test("books an individual event and shows the confirmation", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto("/dana-rivera");
  await expect(page.getByRole("heading", { level: 1, name: "Dana Rivera" })).toBeVisible();
  await page.getByRole("link", { name: /Intro call/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Intro call" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Español" })).toBeVisible();

  await page.getByText("60 minutes").click();
  await pickFirstSlot(page, /^Times for /);
  await expect(page.getByRole("heading", { name: "Enter your details" })).toBeVisible();

  // A required custom question blocks submission (the server validates again).
  await page.getByLabel("Full name").fill("Pat Example");
  await page.getByLabel("Email").fill("pat.example@example.com");
  await page.getByRole("button", { name: "Schedule meeting" }).click();
  await expect(page.getByText("Please correct the highlighted fields.")).toBeVisible();

  await page.getByLabel("Company name").fill("Example Bakery LLC");
  await page.getByLabel(/Funding needed/).selectOption("50k_250k");
  await page.getByRole("button", { name: "Schedule meeting" }).click();

  await expect(page).toHaveURL(/\/b\/[A-Za-z0-9_-]{43}\?new=1$/);
  await expect(page.getByRole("heading", { name: "You are scheduled" })).toBeVisible();
  await expect(page.getByText("Dana Rivera")).toBeVisible();
  await expect(page.getByText("Intro call")).toBeVisible();
  await expect(page.getByText(/America\/Chicago|Central/).first()).toBeVisible();
  await expect(page.getByText(/Microsoft Teams link will be in your confirmation email|Preparing your Microsoft Teams link/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Download calendar file (.ics)" })).toHaveAttribute("href", /\/b\/.+\/ics$/);
  const meta = await page.locator('meta[name="robots"]').getAttribute("content");
  expect(meta).toContain("noindex");

  // Invitee cancels.
  await page.getByRole("button", { name: "Cancel meeting" }).click();
  await page.getByLabel(/Reason for cancelling/).fill("Testing");
  await page.getByRole("button", { name: "Yes, cancel meeting" }).click();
  await expect(page.getByRole("heading", { name: "This meeting was cancelled" })).toBeVisible();

  // `next dev` logs a notice because the app CSP blocks eval; production builds never use it.
  expect(errors.filter((e) => !/Download the React DevTools|favicon|unsafe-eval/.test(e))).toEqual([]);
});

test("books a round-robin team event with one assigned host", async ({ page }) => {
  await page.goto("/t/sales/consultation");
  await expect(page.getByRole("heading", { level: 1, name: "Funding consultation" })).toBeVisible();
  // Team pages never list members.
  await expect(page.getByText(/Alex Morgan|Bea Santos|Carlos Mendez/)).toHaveCount(0);
  await pickFirstSlot(page, /^Times for /);
  await page.getByLabel("Full name").fill("Robin Example");
  await page.getByLabel("Email").fill("robin.example@example.com");
  await page.getByRole("button", { name: "Schedule meeting" }).click();
  await expect(page.getByRole("heading", { name: "You are scheduled" })).toBeVisible();
  const hosts = page.getByRole("listitem").filter({ hasText: /Alex Morgan|Bea Santos|Carlos Mendez/ });
  await expect(hosts).toHaveCount(1);
  await expect(hosts).toHaveText(/Alex Morgan|Bea Santos/);
  const firstUrl = page.url();

  // Invitee reschedules: a new link replaces the old one, and the old one says so.
  await page.getByRole("button", { name: "Reschedule" }).click();
  await expect(page.getByRole("heading", { name: "Pick a new time" })).toBeVisible();
  const available = page.getByRole("button", { name: /\d{4}, times available$/ });
  await expect(available.nth(1)).toBeVisible({ timeout: 30_000 });
  await available.nth(1).click();
  await page.getByRole("region", { name: /^Times for / }).getByRole("button").first().click();
  await page.getByRole("button", { name: "Confirm new time" }).click();
  await expect(page).toHaveURL(/\/b\/[A-Za-z0-9_-]{43}\?updated=1$/);
  await expect(page.getByText("Your meeting has been moved.", { exact: false })).toBeVisible();
  await page.goto(firstUrl.replace("?new=1", ""));
  await expect(page.getByRole("heading", { name: "This booking was rescheduled" })).toBeVisible();
});

test("the Spanish variant renders in Spanish and routes to its own pool", async ({ page }) => {
  await page.goto("/t/sales/consultation");
  await page.getByRole("link", { name: "Español" }).click();
  await expect(page).toHaveURL(/\/t\/sales\/consultation\/es$/);
  await expect(page.getByRole("heading", { level: 1, name: "Consulta de financiamiento" })).toBeVisible();
  await expect(page.locator('div[lang="es"]').first()).toBeVisible();
  await pickFirstSlot(page, /^Horarios para el /);
  await page.getByLabel("Nombre completo").fill("Ana Ejemplo");
  await page.getByLabel("Correo electrónico").fill("ana.ejemplo@example.com");
  await page.getByRole("button", { name: "Agendar reunión" }).click();
  await expect(page.getByRole("heading", { name: "Su reunión está agendada" })).toBeVisible();
  await expect(page.getByText("Carlos Mendez")).toBeVisible();
});

test("unknown pages share one 404", async ({ page }) => {
  const res = await page.goto("/nobody-here/intro-call");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  const res2 = await page.goto("/b/" + "x".repeat(43));
  expect(res2?.status()).toBe(404);
});
