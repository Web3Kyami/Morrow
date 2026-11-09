import { readFile, mkdir, writeFile } from "node:fs/promises";
import { memoryConfig } from "../src/config.js";
import { createPool, tenantTransaction } from "../src/database.js";
import { LessonService } from "../src/lessons.js";
import { verifyMainnetRegister, type MainnetProof } from "../src/memory.js";
import { walrusGateway } from "../src/providers/walrus.js";

// Read-only provider gate. This command cannot create a Mainnet memory or initiate a payment.
async function verify() {
  let testnet: { state?: string; accountId?: string } | null = null;
  try {
    testnet = JSON.parse(
      await readFile(".morrow/proofs/walrus-testnet.json", "utf8"),
    );
  } catch {}
  if (testnet?.state !== "RECALL_VERIFIED") {
    console.log(
      "BLOCKED: verified Testnet write, completion and fresh recall required before Mainnet promotion",
    );
    process.exitCode = 1;
    return;
  }
  const config = memoryConfig();
  if (config.network !== "mainnet" || config.accountId === testnet.accountId)
    throw new Error("SEPARATE_MAINNET_ACCOUNT_REQUIRED");
  const reservation = JSON.parse(
    await readFile(".morrow/payment-reservation.json", "utf8"),
  ) as { tenantId: string };
  if (!config.namespace.endsWith(`:${reservation.tenantId}`))
    throw new Error("SCOPED_MAINNET_NAMESPACE_REQUIRED");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_MISSING");
  const pool = createPool(process.env.DATABASE_URL),
    gateway = walrusGateway(config);
  try {
    const lessons = new LessonService(pool, config, gateway);
    const r = await tenantTransaction(pool, reservation.tenantId, (db) =>
      db.query(
        `SELECT id,fingerprint,job_id,blob_id,completed_at FROM morrow.lessons
      WHERE tenant_id=$1 AND network='mainnet' AND account_id=$2 AND namespace=$3 AND fingerprint_version=2 AND state IN ('COMPLETED','RECALL_VERIFIED') ORDER BY completed_at LIMIT 100`,
        [reservation.tenantId, config.accountId, config.namespace],
      ),
    );
    const rows: MainnetProof[] = [];
    for (const row of r.rows) {
      let freshRecall = false;
      try {
        await lessons.verifyRecall(reservation.tenantId, row.id, gateway);
        freshRecall = true;
      } catch {}
      rows.push({
        network: "mainnet",
        fingerprint: row.fingerprint,
        blobId: row.blob_id,
        jobId: row.job_id,
        completedAt: row.completed_at.toISOString(),
        approved: true,
        freshRecall,
      });
    }
    const result = verifyMainnetRegister(rows);
    await mkdir(".morrow/proofs", { recursive: true, mode: 0o700 });
    await writeFile(
      ".morrow/proofs/mainnet-register.json",
      JSON.stringify(
        { ...result, rows, checkedAt: new Date().toISOString() },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      `${result.status}: ${result.distinctConfirmedMainnetMemories}/10 distinct completed and freshly recalled Mainnet memories`,
    );
    if (result.status !== "PASS") process.exitCode = 1;
  } finally {
    gateway.close();
    await pool.end();
  }
}
await verify().catch(() => {
  console.error(
    "BLOCKED: Mainnet proof prerequisites or provider recall unavailable",
  );
  process.exitCode = 1;
});
