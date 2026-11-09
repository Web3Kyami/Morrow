import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { memoryConfig } from "../src/config.js";
import { createPool } from "../src/database.js";
import { ResolutionService } from "../src/resolution.js";
import { tatumGateway } from "../src/providers/tatum.js";
import { walrusGateway } from "../src/providers/walrus.js";
import { classifyMemoryJob } from "../src/memory.js";

async function save(name: string, data: unknown) {
  await mkdir(".morrow/proofs", { recursive: true, mode: 0o700 });
  const path = `.morrow/proofs/${name}.json`,
    temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
async function load(name: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(`.morrow/proofs/${name}.json`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
async function payment() {
  const required = ["DATABASE_URL", "TATUM_API_KEY"];
  const missing = required.filter((n) => !process.env[n]);
  let reservation: unknown;
  try {
    reservation = JSON.parse(
      await readFile(
        process.env.MORROW_RESERVATION_PATH ??
          ".morrow/payment-reservation.json",
        "utf8",
      ),
    );
  } catch {
    missing.push("pre-broadcast payment reservation");
  }
  if (missing.length) {
    await save("payment-testnet", {
      status: "BLOCKED",
      missing,
      revision,
      checkedAt: new Date().toISOString(),
    });
    console.log(`Tatum proof BLOCKED: ${missing.join(", ")}`);
    return false;
  }
  const r = z
    .object({
      network: z.literal("testnet"),
      tenantId: z.uuid(),
      operatorId: z.uuid(),
      caseId: z.uuid(),
      digest: z.string(),
    })
    .parse(reservation);
  const db = createPool(process.env.DATABASE_URL!);
  const gateway = tatumGateway(process.env.TATUM_API_KEY!);
  try {
    const service = new ResolutionService(db, gateway);
    const actor = {
      tenantId: r.tenantId,
      operatorId: r.operatorId,
      role: "judge" as const,
    };
    const check = await service.investigate(actor, r.caseId);
    if (check.verdict !== "MATCH") {
      await save("payment-testnet", {
        status: "FAIL",
        ...check,
        revision,
        checkedAt: new Date().toISOString(),
      });
      console.log(`Tatum proof: ${check.verdict}`);
      return false;
    }
    const state = await service.inspect(actor, r.caseId);
    if (state.entitled) {
      const executed = state.events.find(
        (event) =>
          event.kind === "REPAIR_EXECUTED" && event.data.digest === r.digest,
      );
      if (!executed) throw new Error("EXISTING_ACCESS_WITHOUT_REPAIR_PROOF");
      await save("payment-testnet", {
        status: "PASS",
        repairStatus: "READBACK_CONFIRMED",
        network: "testnet",
        source: "tatum",
        digest: r.digest,
        caseId: r.caseId,
        repairId: executed.data.repairId,
        decisionId: executed.data.decisionId,
        revision,
        checkedAt: new Date().toISOString(),
        reconciled: true,
      });
      console.log(
        "Repair already present; existing audit remains the evidence",
      );
      return true;
    }
    const decision = await service.decide(actor, {
      caseId: r.caseId,
      caseVersion: state.caseVersion,
      policyVersion: state.policyVersion,
      kind: "APPROVED",
    });
    const repair = await service.repair(actor, {
      caseId: r.caseId,
      decisionId: decision.id,
      idempotencyKey: `testnet-proof-${r.caseId}`,
    });
    await save("payment-testnet", {
      ...repair,
      status: "PASS",
      repairStatus: repair.status,
      network: "testnet",
      source: "tatum",
      digest: r.digest,
      caseId: r.caseId,
      decisionId: decision.id,
      revision,
      checkedAt: new Date().toISOString(),
    });
    console.log(
      "PASS: Tatum matched precommitted payment and Neon confirmed approved repair",
    );
    return true;
  } finally {
    gateway.close?.();
    await db.end();
  }
}
const memoryProofSchema = z.object({
  network: z.literal("testnet"),
  accountId: z.string(),
  namespace: z.string(),
  text: z.string(),
  fingerprint: z.string(),
  jobId: z.string(),
  blobId: z.string().nullable(),
  state: z.string(),
});
async function memory(recallOnly: boolean) {
  const required = [
    "MEMWAL_NETWORK",
    "MEMWAL_ACCOUNT_ID",
    "MEMWAL_PRIVATE_KEY",
    "MEMWAL_NAMESPACE",
  ];
  const missing = required.filter((n) => !process.env[n]);
  if (missing.length) {
    await save("walrus-testnet-blocked", {
      status: "BLOCKED",
      missing,
      revision,
      checkedAt: new Date().toISOString(),
    });
    console.log(`Walrus Testnet proof BLOCKED: ${missing.join(", ")}`);
    return false;
  }
  const config = memoryConfig();
  if (config.network !== "testnet") throw new Error("TESTNET_REQUIRED");
  const client = walrusGateway(config);
  try {
    const prior = await load("walrus-testnet");
    let record = prior ? memoryProofSchema.parse(prior) : null;
    if (
      record &&
      (record.accountId !== config.accountId ||
        record.namespace !== config.namespace)
    )
      throw new Error("PROOF_SCOPE_CHANGED");
    if (recallOnly) {
      if (
        !record?.blobId ||
        !["COMPLETED", "RECALL_VERIFIED"].includes(record.state)
      )
        throw new Error("NO_COMPLETED_PROOF");
      const hits = await client.recall(record.text);
      if (
        !hits.some(
          (h) =>
            h.blobId === record!.blobId &&
            createHash("sha256").update(h.text).digest("hex") ===
              record!.fingerprint,
        )
      )
        throw new Error("FRESH_RECALL_NOT_CONFIRMED");
      await save("walrus-testnet", {
        ...record,
        state: "RECALL_VERIFIED",
        revision,
        recalledAt: new Date().toISOString(),
        freshProcess: true,
      });
      console.log(
        "PASS: fresh-process authenticated Walrus Testnet recall matched completed blob and exact content",
      );
      return true;
    }
    if (record && ["COMPLETED", "RECALL_VERIFIED"].includes(record.state)) {
      console.log(
        "Completed Testnet blob retained; run proof:memory:recall for fresh retrieval evidence",
      );
      return true;
    }
    if (!record) {
      const text =
        "Morrow fictional foundation integration probe v1. Before access repair: verify the current payment intent and policy, require merchant approval, grant idempotently, and confirm persisted entitlement readback. This probe is not evidence that a customer repair occurred.";
      const fingerprint = createHash("sha256").update(text).digest("hex");
      const accepted = await client.remember(
        text,
        `morrow-foundation-${fingerprint}`,
      );
      record = {
        network: "testnet",
        accountId: config.accountId,
        namespace: config.namespace,
        text,
        fingerprint,
        jobId: accepted.jobId,
        blobId: null,
        state: "ACCEPTED",
      };
      await save("walrus-testnet", { ...record, revision });
    }
    const status = classifyMemoryJob(await client.status(record.jobId));
    if (status.jobId && status.jobId !== record.jobId)
      throw new Error("WRONG_JOB");
    const complete = status.state === "COMPLETED";
    await save("walrus-testnet", {
      ...record,
      state: status.state,
      blobId: complete ? status.blobId : null,
      revision,
      checkedAt: new Date().toISOString(),
    });
    console.log(
      `Walrus Testnet: ${status.state}. ${complete ? "Run proof:memory:recall in a separate process." : "Rerun proof:memory:testnet to poll the same job."}`,
    );
    return complete;
  } finally {
    client.close();
  }
}
const phase = process.argv[2] ?? "all";
const actions: Array<{ name: string; run: () => Promise<boolean> }> = [];
if (phase === "all" || phase === "payment")
  actions.push({ name: "payment", run: payment });
if (phase === "all" || phase === "memory")
  actions.push({ name: "memory", run: () => memory(false) });
if (phase === "recall")
  actions.push({ name: "recall", run: () => memory(true) });
if (!actions.length) {
  console.error("FAIL: unknown proof phase");
  process.exitCode = 1;
}
for (const action of actions) {
  try {
    if (!(await action.run())) process.exitCode = 1;
  } catch {
    await save(`testnet-${action.name}-error`, {
      status: "FAIL",
      phase: action.name,
      code: "PROVIDER_OR_CONFIGURATION_ERROR",
      revision,
      checkedAt: new Date().toISOString(),
    });
    console.error(`FAIL: Testnet ${action.name} proof; no success claimed`);
    process.exitCode = 1;
  }
}
