import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests for the public booking flow. The global setup recreates and seeds a
 * dedicated database (tests/e2e/seed.ts); the web server runs `next dev` against it.
 * Environment values below are test-only placeholders, never real secrets.
 */
const PORT = Number(process.env.E2E_PORT ?? 3417);
const BASE_URL = `http://localhost:${PORT}`;
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/btc_e2e_booking";

// Use a preinstalled Chromium when the bundled revision is not downloaded.
const chromiumPath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /booking\.spec\.ts/,
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    timezoneId: "America/Chicago",
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: BASE_URL + "/brand/btc-mark.png",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      APP_BASE_URL: BASE_URL,
      DATABASE_URL,
      ENTRA_TENANT_ID: "00000000-0000-4000-8000-000000000001",
      ENTRA_CLIENT_ID: "00000000-0000-4000-8000-000000000002",
      ENTRA_CLIENT_SECRET: "e2e-client-secret",
      TOKEN_ENCRYPTION_KEYS: "k1:" + Buffer.alloc(32, 7).toString("base64"),
      TOKEN_ENCRYPTION_ACTIVE_KID: "k1",
      IP_HASH_SALT: "e2e-ip-hash-salt-000000",
      CRON_SECRET: "e2e-cron-secret-000000",
      TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
      RESEND_API_KEY: "",
    },
  },
});
