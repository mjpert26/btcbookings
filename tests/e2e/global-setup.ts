import { execFileSync } from "node:child_process";
import path from "node:path";
import { seedE2E } from "./seed";

export default async function globalSetup() {
  try {
    execFileSync(path.resolve(__dirname, "../../scripts/local-db.sh"), ["start"], { stdio: "ignore" });
  } catch {
    // Assume an externally managed database.
  }
  await seedE2E();
}
