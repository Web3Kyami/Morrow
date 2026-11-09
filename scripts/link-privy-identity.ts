import { createHash } from "node:crypto";
import { z } from "zod";
import { createPool } from "../src/database.js";

const env = z
  .object({
    DIRECT_URL: z.url(),
    PRIVY_APP_ID: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    PRIVY_USER_ID: z.string().min(5).max(512),
    MERCHANT_TENANT_ID: z.uuid(),
    MERCHANT_OPERATOR_ID: z.uuid(),
  })
  .safeParse(process.env);

if (!env.success) {
  console.error(
    "BLOCKED: set DIRECT_URL, PRIVY_APP_ID, PRIVY_USER_ID, MERCHANT_TENANT_ID and MERCHANT_OPERATOR_ID",
  );
  process.exitCode = 1;
} else if (new URL(env.data.DIRECT_URL).hostname.includes("-pooler.")) {
  console.error("BLOCKED: direct database connection required");
  process.exitCode = 1;
} else {
  const {
    DIRECT_URL,
    PRIVY_APP_ID,
    PRIVY_USER_ID,
    MERCHANT_TENANT_ID,
    MERCHANT_OPERATOR_ID,
  } = env.data;
  const subjectHash = createHash("sha256")
    .update("morrow:privy-user:v1\0")
    .update(PRIVY_APP_ID)
    .update("\0")
    .update(PRIVY_USER_ID)
    .digest("hex");
  const pool = createPool(DIRECT_URL);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const operator = await db.query(
      `SELECT t.kind,o.role,o.active
       FROM morrow.tenants t JOIN morrow.operators o ON o.tenant_id=t.id
       WHERE t.id=$1 AND o.id=$2 FOR UPDATE OF t,o`,
      [MERCHANT_TENANT_ID, MERCHANT_OPERATOR_ID],
    );
    const row = operator.rows[0];
    if (
      !row ||
      row.kind !== "merchant" ||
      row.role !== "merchant" ||
      !row.active
    )
      throw new Error("MERCHANT_OPERATOR_NOT_ACTIVE");

    const existing = await db.query(
      `SELECT tenant_id,operator_id,active FROM morrow.merchant_privy_identities
       WHERE app_id=$1 AND subject_hash=$2 FOR UPDATE`,
      [PRIVY_APP_ID, subjectHash],
    );
    if (existing.rowCount) {
      const linked = existing.rows[0];
      if (
        linked.tenant_id !== MERCHANT_TENANT_ID ||
        linked.operator_id !== MERCHANT_OPERATOR_ID
      )
        throw new Error("PRIVY_IDENTITY_ALREADY_LINKED_ELSEWHERE");
      if (!linked.active)
        await db.query(
          `UPDATE morrow.merchant_privy_identities SET active=true
           WHERE app_id=$1 AND subject_hash=$2`,
          [PRIVY_APP_ID, subjectHash],
        );
    } else {
      await db.query(
        `INSERT INTO morrow.merchant_privy_identities(app_id,subject_hash,tenant_id,operator_id)
         VALUES ($1,$2,$3,$4)`,
        [PRIVY_APP_ID, subjectHash, MERCHANT_TENANT_ID, MERCHANT_OPERATOR_ID],
      );
    }
    await db.query("COMMIT");
    console.log("PASS: Privy identity linked to the active merchant operator");
  } catch {
    await db.query("ROLLBACK");
    console.error(
      "FAIL: identity was not linked; inspect private operator records",
    );
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}
