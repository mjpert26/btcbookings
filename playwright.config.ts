import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests for the internal UI. They run against an already running app
 * (E2E_BASE_URL, default http://localhost:3100) whose database holds the sessions named
 * by E2E_USER_TOKEN and E2E_ADMIN_TOKEN. See tests/e2e/internal.spec.ts.
 *
 * CHROMIUM_PATH points Playwright at a preinstalled Chromium when the bundled revision is
 * not downloaded (for example in sandboxes without network access).
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    trace: "off",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, grepInvert: /@mobile/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
});
