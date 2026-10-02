import { defineConfig } from "vitest/config";
import path from "node:path";
const __dirname = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // server-only throws outside a React Server Components bundle; tests run in plain Node.
      "server-only": path.resolve(__dirname, "tests/helpers/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["tests/helpers/setup-env.ts"],
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/helpers/global-db-setup.ts"],
          // Integration files share one database; run them one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
