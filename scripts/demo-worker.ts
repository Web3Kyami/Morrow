import { createPool } from "../src/database.js";
import { DemoLessonWorker } from "../src/demo-lesson-worker.js";
import { tenantMemoryFor } from "../src/lesson-factory.js";
import { spawnSync } from "node:child_process";
const once = process.argv.includes("--once");
const pool = createPool(process.env.DATABASE_URL!);
// Invoked under the Morrow worker singleton lock. Per-payment shared-payer
// lock also coordinates with every other authorized harness using this pool.
do {
  const result = spawnSync(
    "flock",
    [
      "-n",
      "/root/.config/kyami/testnet-wallets/locks/sui-test-2-testnet.lock",
      process.execPath,
      "--env-file-if-exists=.env",
      "--import",
      "tsx",
      "scripts/demo-payment-once.ts",
    ],
    { stdio: "inherit", timeout: 85000 },
  );
  const memoryResult = await new DemoLessonWorker(
    pool,
    tenantMemoryFor,
  ).runOne();
  if (memoryResult) console.log("Testnet lesson:", memoryResult);
  if (once) {
    process.exitCode = result.status ?? 1;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
} while (true);

await pool.end();
