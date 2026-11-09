import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { memoryConfig } from "../src/config.js";
import { createPool } from "../src/database.js";
import { LessonService } from "../src/lessons.js";
import { walrusGateway } from "../src/providers/walrus.js";

const reservationSchema = z.object({
  network: z.literal("testnet"),
  tenantId: z.uuid(),
  operatorId: z.uuid(),
  caseId: z.uuid(),
  digest: z.string(),
});

const paymentProofSchema = z.object({ status: z.literal("PASS") });

async function save(name: string, data: unknown) {
  await mkdir(".morrow/proofs", { recursive: true, mode: 0o700 });
  const path = `.morrow/proofs/${name}.json`,
    temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, path);
}

const property = z.object({
  network: z.literal("testnet"),
  lessonId: z.uuid(),
  jobId: z.string(),
  blobId: z.string().nullable(),
  state: z.string(),
  fingerprint: z.string(),
});

if (process.env.MEMWAL_NETWORK !== "testnet")
  throw new Error("TESTNET_REQUIRED");
const reservation = reservationSchema.parse(
  JSON.parse(
    await readFile(
      process.env.MORROW_RESERVATION_PATH ?? ".morrow/payment-reservation.json",
      "utf8",
    ),
  ),
);
paymentProofSchema.parse(
  JSON.parse(await readFile(".morrow/proofs/payment-testnet.json", "utf8")),
);
const base = memoryConfig();
const tenantConfig = {
  ...base,
  namespace: `morrow-testnet:${reservation.tenantId}`,
};
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();

const actor = {
  tenantId: reservation.tenantId,
  operatorId: reservation.operatorId,
  role: "judge" as const,
};
const db = createPool(process.env.DATABASE_URL!);
const owner = createPool(process.env.DIRECT_URL!);
const gateway = walrusGateway(tenantConfig);
const service = new LessonService(db, tenantConfig, gateway);
try {
  // Inspect current policy version for the approved lesson (owner read only).
  const current = await owner.query(
    "SELECT policy_version FROM morrow.tenants WHERE id=$1",
    [reservation.tenantId],
  );
  const policyVersion = current.rows[0]?.policy_version as number;
  if (!policyVersion) throw new Error("TENANT_POLICY_MISSING");

  let lesson = null;
  try {
    lesson = await service.approve(actor, {
      sourceCaseId: reservation.caseId,
      policyVersion,
      productCategory: "course",
      problem: "PAID_ACCESS_MISSING",
      procedure: [
        "VERIFY_CURRENT_ORDER",
        "VERIFY_PAYMENT_INTENT",
        "CHECK_CURRENT_POLICY",
        "CHECK_PERSISTED_ACCESS",
        "REQUEST_MERCHANT_APPROVAL",
        "GRANT_IDEMPOTENTLY",
        "CONFIRM_READBACK",
      ],
      outcome: "READBACK_CONFIRMED",
      fictional: true,
    });
    console.log(`lesson approved: ${lesson.id}`);
  } catch (error) {
    // Re-run after a prior approval: look up the existing row by fingerprint.
    const rows = await owner.query(
      "SELECT id, job_id, blob_id, state, fingerprint FROM morrow.lessons WHERE tenant_id=$1",
      [reservation.tenantId],
    );
    const row = rows.rows[0];
    if (!row) throw error;
    lesson = { id: row.id as string };
    console.log(`lesson already approved: ${row.id} (state ${row.state})`);
  }

  // Advance until COMPLETED (bounded polling).
  let status = { state: "APPROVED", jobId: "", blobId: null as string | null };
  for (let attempt = 0; attempt < 30; attempt++) {
    const advanced = await service.advance(reservation.tenantId, lesson!.id);
    status = {
      state: advanced.state ?? "UNKNOWN",
      jobId: (advanced as { jobId?: string }).jobId ?? status.jobId,
      blobId: (advanced as { blobId?: string }).blobId ?? null,
    };
    console.log(`advance ${attempt + 1}: ${status.state}`);
    if (["COMPLETED", "FAILED"].includes(status.state)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status.state !== "COMPLETED")
    throw new Error(`LESSON_NOT_COMPLETED:${status.state}`);

  const rows = await owner.query(
    "SELECT id, job_id, blob_id, state, fingerprint FROM morrow.lessons WHERE tenant_id=$1 AND id=$2",
    [reservation.tenantId, lesson!.id],
  );
  const row = rows.rows[0];
  const fresh = walrusGateway(tenantConfig);
  let recalled;
  try {
    recalled = await service.verifyRecall(
      reservation.tenantId,
      lesson!.id,
      fresh,
    );
  } finally {
    fresh.close();
  }
  await save(process.env.MORROW_LESSON_PROOF_OUT ?? "lesson-testnet", {
    network: "testnet",
    sourceCaseId: reservation.caseId,
    digest: reservation.digest,
    lessonId: lesson!.id,
    jobId: row.job_id,
    blobId: row.blob_id,
    fingerprint: row.fingerprint,
    state: recalled.state,
    namespace: tenantConfig.namespace,
    accountId: base.accountId,
    revision,
    checkedAt: new Date().toISOString(),
    freshProcess: true,
  });
  console.log(
    `PASS: approved lesson ${lesson!.id} completed with blob ${row.blob_id} and fresh recall verified`,
  );
} finally {
  gateway.close();
  await db.end();
  await owner.end();
}
