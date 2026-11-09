import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createPool } from "../src/database.js";

export async function migrate(url: string) {
  if (new URL(url).hostname.includes("-pooler."))
    throw new Error("Use a direct migration connection");
  const pool = createPool(url);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('morrow-migrations'))",
    );
    await db.query(
      "CREATE TABLE IF NOT EXISTS public.morrow_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort()) {
      const sql = await readFile(
        new URL(`../migrations/${name}`, import.meta.url),
        "utf8",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = await db.query(
        "SELECT checksum FROM public.morrow_migrations WHERE name=$1",
        [name],
      );
      if (prior.rows.length) {
        if (prior.rows[0].checksum !== checksum)
          throw new Error("Applied migration checksum differs");
        continue;
      }
      await db.query(sql);
      await db.query(
        "INSERT INTO public.morrow_migrations(name,checksum) VALUES ($1,$2)",
        [name, checksum],
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DIRECT_URL;
  if (!url) {
    console.error("BLOCKED: DIRECT_URL missing");
    process.exitCode = 1;
  } else
    await migrate(url)
      .then(() => console.log("PASS: migrations applied"))
      .catch(() => {
        console.error(
          "FAIL: migration failed; inspect private database configuration",
        );
        process.exitCode = 1;
      });
}
