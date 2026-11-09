import { createPool } from "../src/database.js";
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
if (!process.env.TEST_DATABASE_URL || !process.env.TEST_RUNTIME_DATABASE_URL) {
  console.error(
    "BLOCKED: explicit disposable TEST_DATABASE_URL and restricted TEST_RUNTIME_DATABASE_URL required",
  );
  process.exitCode = 1;
} else {
  const testTarget = new URL(process.env.TEST_DATABASE_URL),
    runtimeTarget = process.env.DATABASE_URL
      ? new URL(process.env.DATABASE_URL)
      : null;
  if (
    runtimeTarget &&
    testTarget.hostname.replace("-pooler", "") ===
      runtimeTarget.hostname.replace("-pooler", "") &&
    testTarget.pathname === runtimeTarget.pathname
  )
    throw Error(
      "TEST_DATABASE_URL must identify a separate disposable database",
    );
  const fixtures = createPool(process.env.TEST_DATABASE_URL);
  try {
    if (
      (
        await fixtures.query(
          "SELECT to_regclass('morrow.demo_signing_budget') AS table_name",
        )
      ).rows[0]?.table_name
    )
      await fixtures.query("DELETE FROM morrow.demo_signing_budget");
  } finally {
    await fixtures.end();
  }
  const files = (await readdir("tests/db"))
    .filter((n) => n.endsWith(".test.ts"))
    .sort()
    .map((n) => `tests/db/${n}`);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    { stdio: "inherit", env: process.env },
  );
  process.exitCode = result.status ?? 1;
}
