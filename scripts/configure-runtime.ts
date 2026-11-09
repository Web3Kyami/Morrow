import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { createPool } from "../src/database.js";

const url = process.env.DIRECT_URL;
if (!url) throw new Error("DIRECT_URL missing");
const pool = createPool(url);
try {
  const exists = await pool.query(
    "SELECT 1 FROM pg_roles WHERE rolname='morrow_app'",
  );
  const password = exists.rowCount
    ? undefined
    : randomBytes(32).toString("base64url");
  if (password)
    await pool.query(
      `CREATE ROLE morrow_app LOGIN PASSWORD ${pg.escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
  await pool.query("GRANT USAGE ON SCHEMA morrow TO morrow_app");
  await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA morrow TO morrow_app");
  // Identity subject hashes are available only through the narrow lookup;
  // the application role cannot enumerate or alter Privy links.
  await pool.query(
    "REVOKE ALL ON TABLE morrow.merchant_privy_identities FROM morrow_app",
  );
  await pool.query(
    "GRANT INSERT ON morrow.payment_checks,morrow.decisions,morrow.entitlements,morrow.repairs,morrow.case_events TO morrow_app",
  );
  await pool.query("GRANT UPDATE (version) ON morrow.cases TO morrow_app");
  await pool.query(
    "GRANT UPDATE (id) ON morrow.operators,morrow.tenants TO morrow_app",
  );
  await pool.query(
    "GRANT UPDATE (used_requests) ON morrow.demo_sessions TO morrow_app",
  );
  await pool.query(
    "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA morrow TO morrow_app",
  );
  await pool.query("GRANT INSERT ON morrow.lessons TO morrow_app");
  await pool.query(
    "GRANT UPDATE (state,job_id,blob_id,completed_at,recalled_at) ON morrow.lessons TO morrow_app",
  );
  await pool.query("GRANT INSERT ON morrow.help_requests TO morrow_app");
  await pool.query("GRANT INSERT ON morrow.help_intake_attempts TO morrow_app");
  await pool.query(
    "GRANT UPDATE (issue,access_token_hash,access_expires_at) ON morrow.help_requests TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.lookup_order_ref(text, text) TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.lookup_help_access(uuid, text) TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.provision_demo_case(uuid, uuid, uuid, uuid, text, text, text, numeric, text, text, text) TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.provision_demo_run(uuid, uuid, text, text, text, jsonb) TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.lookup_merchant_identity(text) TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.lookup_merchant_privy_identity(text,text) TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.delete_merchant_session(text) TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.consume_merchant_session(text) TO morrow_app",
  );
  await pool.query("GRANT INSERT ON morrow.merchant_sessions TO morrow_app");
  await pool.query(
    "GRANT UPDATE (used_requests) ON morrow.merchant_sessions TO morrow_app",
  );
  await pool.query("GRANT DELETE ON morrow.merchant_sessions TO morrow_app");
  await pool.query(
    "GRANT SELECT, INSERT, UPDATE(ciphertext) ON morrow.demo_run_receipts TO morrow_app",
  );
  await pool.query(
    "GRANT SELECT,INSERT ON morrow.demo_gas_reservations TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.lookup_demo_receipt(text), morrow.prepare_demo_payment(uuid,uuid,uuid,text,text,text,numeric,timestamptz) TO morrow_app",
  );
  await pool.query(
    "GRANT SELECT,INSERT,UPDATE ON morrow.demo_payment_jobs TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.claim_demo_payment_job(uuid), morrow.reserve_demo_signing_budget(numeric) TO morrow_app",
  );
  await pool.query(
    "GRANT SELECT,INSERT,UPDATE ON morrow.demo_lesson_drafts,morrow.demo_lesson_jobs,morrow.investigation_runs,morrow.comparison_baselines TO morrow_app",
  );
  await pool.query(
    "GRANT SELECT,INSERT,UPDATE ON morrow.merchant_lesson_drafts TO morrow_app",
  );
  await pool.query(
    "GRANT UPDATE(submission_attempt) ON morrow.lessons TO morrow_app",
  );
  await pool.query(
    "GRANT EXECUTE ON FUNCTION morrow.claim_demo_lesson_job(uuid) TO morrow_app",
  );
  if (password) {
    const runtime = new URL(url);
    runtime.username = "morrow_app";
    runtime.password = password;
    const env = await readFile(".env", "utf8");
    await writeFile(
      ".env",
      env.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${runtime.toString()}`),
      { mode: 0o600 },
    );
  }
  console.log(
    "PASS: restricted runtime role configured; credentials kept in private .env",
  );
} catch {
  console.error(
    "FAIL: runtime role configuration; inspect role existence and private configuration",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
