import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../../src/database.js";
import {
  DemoProvisioningService,
  type ReservedIntent,
} from "../../src/demo-provisioning.js";
import {
  DemoPaymentWorker,
  type DemoChain,
} from "../../src/demo-payment-worker.js";
import { ResolutionService } from "../../src/resolution.js";

const url = process.env.TEST_DATABASE_URL!;
test("worker reserves before broadcasting, reconciles lost submit response and never pays twice", async () => {
  const admin = createPool(url),
    db = createPool(process.env.TEST_RUNTIME_DATABASE_URL!);
  const run = await new DemoProvisioningService(db, undefined, {
    deferPayments: true,
  }).provision(crypto.randomUUID());
  let sent = false,
    submissions = 0;
  let prepared: ReservedIntent;
  const chain: DemoChain = {
    prepare: async () =>
      (prepared = {
        digest: crypto.randomUUID().replaceAll("-", "").replaceAll("0", "1"),
        transactionBytes: "dGVzdA==",
        amount: "1000000",
        gasBudget: "2000000",
        gasRefs: [crypto.randomUUID()],
        sender: "0x" + "1".repeat(64),
        recipient: "0x" + "2".repeat(64),
      }),
    observe: async () => (sent ? "SUCCESS" : "ABSENT"),
    submit: async (intent) => {
      const row = (
        await admin.query(
          "SELECT expected_digest FROM morrow.payment_intents WHERE tenant_id=$1",
          [run.tenantId],
        )
      ).rows[0];
      assert.equal(row.expected_digest, intent.digest);
      submissions++;
      sent = true;
      throw Error("LOST_AFTER_BROADCAST");
    },
  };
  const resolution = new ResolutionService(db, {
    getTransaction: async (digest) => {
      const row = (
        await admin.query(
          "SELECT created_at FROM morrow.payment_intents WHERE tenant_id=$1",
          [run.tenantId],
        )
      ).rows[0];
      if (!sent) throw Error("ABSENT");
      return {
        provider: "tatum",
        method: "sui.rpc.v2.LedgerService/GetTransaction",
        network: "testnet",
        digest,
        status: "SUCCESS",
        checkpoint: "42",
        sender: prepared.sender,
        timestamp: new Date(row.created_at.getTime() + 1).toISOString(),
        checkedAt: new Date().toISOString(),
        balanceChanges: [
          {
            address: prepared.recipient,
            coinType: "0x2::sui::SUI",
            amount: "1000000",
          },
        ],
      };
    },
  });
  try {
    const worker = new DemoPaymentWorker(db, chain, resolution);
    assert.equal(await worker.runOne(run.caseId), "UNKNOWN");
    await admin.query(
      "UPDATE morrow.demo_payment_jobs SET not_before=clock_timestamp() WHERE tenant_id=$1",
      [run.tenantId],
    );
    assert.equal(await worker.runOne(run.caseId), "CONFIRMED");
    assert.equal(submissions, 1);
    assert.equal(
      (
        await resolution.inspect(
          { tenantId: run.tenantId, operatorId: run.operatorId, role: "judge" },
          run.caseId,
        )
      ).entitled,
      false,
    );
    assert.equal(await worker.runOne(run.caseId), null);
  } finally {
    await admin.end();
    await db.end();
  }
});
test("reserved payment rechecks policy and live session before signing", async () => {
  const admin = createPool(url),
    db = createPool(process.env.TEST_RUNTIME_DATABASE_URL!);
  try {
    for (const reason of ["POLICY", "SESSION"] as const) {
      const run = await new DemoProvisioningService(db, undefined, {
        deferPayments: true,
      }).provision(crypto.randomUUID());
      let submissions = 0;
      const chain: DemoChain = {
        prepare: async () => ({
          digest: crypto.randomUUID().replaceAll("-", "").replaceAll("0", "1"),
          transactionBytes: "dGVzdA==",
          amount: "1000000",
          gasBudget: "2000000",
          gasRefs: [crypto.randomUUID()],
          sender: "0x" + "1".repeat(64),
          recipient: "0x" + "2".repeat(64),
        }),
        observe: async () => {
          if (reason === "POLICY")
            await admin.query(
              "UPDATE morrow.tenants SET grant_enabled=false WHERE id=$1",
              [run.tenantId],
            );
          else
            await admin.query(
              "UPDATE morrow.demo_sessions SET used_requests=max_requests WHERE tenant_id=$1",
              [run.tenantId],
            );
          return "ABSENT";
        },
        submit: async () => {
          submissions++;
        },
      };
      assert.equal(
        await new DemoPaymentWorker(
          db,
          chain,
          new ResolutionService(db, {
            getTransaction: async () => {
              throw Error("ABSENT");
            },
          }),
        ).runOne(run.caseId),
        "UNKNOWN",
      );
      assert.equal(
        submissions,
        0,
        "revoked permission/session cannot broadcast even reserved bytes",
      );
      const row = (
        await admin.query(
          "SELECT digest,state,error_code FROM morrow.demo_payment_jobs WHERE tenant_id=$1",
          [run.tenantId],
        )
      ).rows[0];
      assert.ok(
        row.digest,
        "reservation retained for read-only reconciliation",
      );
      assert.equal(
        row.error_code,
        reason === "POLICY" ? "POLICY_DENIED" : "SESSION_EXPIRED",
      );
      await admin.query(
        "UPDATE morrow.demo_payment_jobs SET not_before=clock_timestamp() WHERE tenant_id=$1",
        [run.tenantId],
      );
      const reclaimed = await admin.query(
        "SELECT case_id FROM morrow.claim_demo_payment_job($1)",
        [run.caseId],
      );
      assert.equal(
        reclaimed.rowCount,
        0,
        "a blocked UNKNOWN payment must not occupy the automatic worker queue until its blocker is cleared",
      );
    }
  } finally {
    await admin.end();
    await db.end();
  }
});
