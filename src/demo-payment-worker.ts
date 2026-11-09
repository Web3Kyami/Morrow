import { tenantTransaction, type Database } from "./database.js";
import { authorizeOperator, type Actor } from "./authorization.js";
import { DomainError } from "./errors.js";
import {
  reservedIntentSchema,
  type ReservedIntent,
} from "./demo-provisioning.js";
import type { ResolutionService } from "./resolution.js";

export interface DemoChain {
  prepare(): Promise<ReservedIntent>;
  observe(digest: string): Promise<"SUCCESS" | "FAILED" | "ABSENT" | "UNKNOWN">;
  submit(intent: ReservedIntent): Promise<void>;
}
/** A durable operation. The signing adapter lives only in the worker process. */
export class DemoPaymentWorker {
  constructor(
    private readonly pool: Database,
    private readonly chain: DemoChain | (() => Promise<DemoChain>),
    private readonly resolution: ResolutionService,
  ) {}
  async runOne(caseId?: string) {
    const job = (
      await this.pool.query("SELECT * FROM morrow.claim_demo_payment_job($1)", [
        caseId ?? null,
      ])
    ).rows[0];
    if (!job) return null;
    const actor: Actor = {
      tenantId: job.tenant_id,
      operatorId: job.operator_id,
      role: "judge",
    };
    const update = async (state: string, error: string | null = null) =>
      tenantTransaction(this.pool, actor.tenantId, (db) =>
        db.query(
          `UPDATE morrow.demo_payment_jobs SET state=$3,error_code=$4,lease_until=CASE WHEN $3='SUBMITTING' THEN clock_timestamp()+interval '90 seconds' ELSE NULL END,not_before=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp() WHERE tenant_id=$1 AND case_id=$2`,
          [actor.tenantId, job.case_id, state, error],
        ),
      );
    try {
      const chain =
        typeof this.chain === "function" ? await this.chain() : this.chain;
      if (!job.digest) {
        await tenantTransaction(this.pool, actor.tenantId, async (db) => {
          const policy = await authorizeOperator(db, actor);
          if (!policy.grant_enabled)
            throw new DomainError("POLICY_DENIED", 403);
          if (job.role === "B") {
            const ready = await db.query(
              `SELECT 1 FROM morrow.demo_payment_jobs a JOIN morrow.lessons l ON l.tenant_id=a.tenant_id AND l.case_id=a.case_id WHERE a.tenant_id=$1 AND a.role='A' AND a.state='CONFIRMED' AND l.state='RECALL_VERIFIED' AND l.policy_version=$2`,
              [actor.tenantId, policy.policy_version],
            );
            if (!ready.rowCount) throw new DomainError("CASE_A_REQUIRED", 409);
          }
          if (job.role === "C") {
            const ready = await db.query(
              `SELECT 1
               FROM morrow.demo_payment_jobs b
               JOIN morrow.comparison_baselines x
                 ON x.tenant_id=b.tenant_id
                AND x.source_case_id=(SELECT a.case_id FROM morrow.demo_payment_jobs a WHERE a.tenant_id=b.tenant_id AND a.role='A')
                AND x.target_case_id=b.case_id
               JOIN morrow.lessons l ON l.tenant_id=x.tenant_id AND l.case_id=x.source_case_id
               WHERE b.tenant_id=$1 AND b.role='B' AND b.state='CONFIRMED'
                 AND x.state='COMPLETE' AND l.state='RECALL_VERIFIED'
                 AND l.policy_version=$2`,
              [actor.tenantId, policy.policy_version],
            );
            if (!ready.rowCount) throw new DomainError("CASE_B_REQUIRED", 409);
          }
        });
        const intent = reservedIntentSchema.parse(await chain.prepare());
        if (
          BigInt(intent.amount) > 1_500_000n ||
          BigInt(intent.gasBudget) > 10_000_000n
        )
          throw new DomainError("SIGNING_BUDGET", 409);
        await tenantTransaction(this.pool, actor.tenantId, async (db) => {
          const policy = await authorizeOperator(db, actor);
          if (!policy.grant_enabled)
            throw new DomainError("POLICY_DENIED", 403);
          const active = await db.query(
            "SELECT 1 FROM morrow.demo_sessions WHERE tenant_id=$1 AND operator_id=$2 AND expires_at>clock_timestamp() AND used_requests<max_requests",
            [actor.tenantId, actor.operatorId],
          );
          if (!active.rowCount) throw new DomainError("SESSION_EXPIRED", 410);
          await db.query("SELECT morrow.reserve_demo_signing_budget($1)", [
            (BigInt(intent.amount) + BigInt(intent.gasBudget)).toString(),
          ]);
          for (const ref of intent.gasRefs) {
            const claimed = await db.query(
              "INSERT INTO morrow.demo_gas_reservations(gas_ref,tenant_id,case_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING gas_ref",
              [ref, actor.tenantId, job.case_id],
            );
            if (!claimed.rowCount) throw new DomainError("GAS_RESERVED", 409);
          }
          const expectedAmount =
            job.role === "C"
              ? (BigInt(intent.amount) + 1n).toString()
              : intent.amount;
          await db.query(
            "SELECT morrow.prepare_demo_payment($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              actor.tenantId,
              actor.operatorId,
              job.case_id,
              intent.digest,
              intent.sender,
              intent.recipient,
              expectedAmount,
              new Date(Date.now() + 30 * 60_000),
            ],
          );
          await db.query(
            `UPDATE morrow.demo_payment_jobs SET state='RESERVED',digest=$3,transaction_bytes=$4,gas_budget=$5,amount=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND case_id=$2`,
            [
              actor.tenantId,
              job.case_id,
              intent.digest,
              intent.transactionBytes,
              intent.gasBudget,
              intent.amount,
            ],
          );
        });
        job.digest = intent.digest;
        job.transaction_bytes = intent.transactionBytes;
        job.gas_budget = intent.gasBudget;
        job.amount = intent.amount;
        job.state = "RESERVED";
      }
      const observed = await chain.observe(job.digest);
      if (observed === "SUCCESS") {
        const check = await this.resolution.investigate(actor, job.case_id);
        const terminalState =
          check.verdict === "MATCH"
            ? "CONFIRMED"
            : check.verdict === "MISMATCH"
              ? "MISMATCH"
              : "UNKNOWN";
        await update(
          terminalState,
          terminalState === "CONFIRMED"
            ? null
            : terminalState === "MISMATCH"
              ? "PAYMENT_MISMATCH"
              : "VERIFICATION_PENDING",
        );
        return terminalState;
      }
      if (observed === "FAILED") {
        await update("FAILED", "CHAIN_FAILED");
        return "FAILED";
      }
      if (observed === "UNKNOWN") {
        await update("UNKNOWN", "PROVIDER_UNAVAILABLE");
        return "UNKNOWN";
      }
      // Only a definitive not-found permits submission/replay of exact bytes.
      const context = await tenantTransaction(
        this.pool,
        actor.tenantId,
        async (db) => {
          const policy = await authorizeOperator(db, actor);
          if (!policy.grant_enabled)
            throw new DomainError("POLICY_DENIED", 403);
          const active = await db.query(
            "SELECT 1 FROM morrow.demo_sessions WHERE tenant_id=$1 AND operator_id=$2 AND expires_at>clock_timestamp() AND used_requests<max_requests",
            [actor.tenantId, actor.operatorId],
          );
          if (!active.rowCount) throw new DomainError("SESSION_EXPIRED", 410);
          return (
            await db.query(
              `SELECT p.sender,p.recipient,p.expires_at FROM morrow.payment_intents p JOIN morrow.cases c ON c.tenant_id=p.tenant_id AND c.order_id=p.order_id WHERE c.tenant_id=$1 AND c.id=$2`,
              [actor.tenantId, job.case_id],
            )
          ).rows[0];
        },
      );
      if (
        !context ||
        Date.now() >= new Date(context.expires_at).getTime() ||
        Date.now() >= new Date(job.expires_at).getTime()
      ) {
        await update("UNKNOWN", "EXPIRED_RECONCILIATION_REQUIRED");
        return "UNKNOWN";
      }
      await update("SUBMITTING");
      const refs = await tenantTransaction(
        this.pool,
        actor.tenantId,
        async (db) =>
          (
            await db.query(
              "SELECT gas_ref FROM morrow.demo_gas_reservations WHERE tenant_id=$1 AND case_id=$2",
              [actor.tenantId, job.case_id],
            )
          ).rows.map((r) => r.gas_ref as string),
      );
      await chain.submit({
        digest: job.digest,
        transactionBytes: job.transaction_bytes,
        sender: context.sender,
        recipient: context.recipient,
        amount: String(job.amount),
        gasBudget: String(job.gas_budget),
        gasRefs: refs,
      });
      const check = await this.resolution.investigate(actor, job.case_id);
      const terminalState =
        check.verdict === "MATCH"
          ? "CONFIRMED"
          : check.verdict === "MISMATCH"
            ? "MISMATCH"
            : "UNKNOWN";
      await update(
        terminalState,
        terminalState === "CONFIRMED"
          ? null
          : terminalState === "MISMATCH"
            ? "PAYMENT_MISMATCH"
            : "VERIFICATION_PENDING",
      );
      return terminalState;
    } catch (error) {
      // Never construct a replacement after reservation or uncertain submission.
      const transport = (error as { code?: unknown })?.code;
      const detail = error instanceof Error ? error.message : "";
      const code =
        error instanceof DomainError
          ? error.code
          : typeof transport === "string" && /^[A-Z_]{2,40}$/.test(transport)
            ? `RPC_${transport}`
            : detail.includes("DEMO_BUDGET_EXCEEDED")
              ? "SIGNING_BUDGET"
              : /^(SIGNING_[A-Z_]+|UNRESERVED_GAS|SIGNER_MISMATCH|SUBMISSION_UNCERTAIN|CONFIRMATION_UNCERTAIN)$/.test(
                    detail,
                  )
                ? detail
                : "PROVIDER_UNAVAILABLE";
      await update(
        job.digest
          ? "UNKNOWN"
          : code === "GAS_RESERVED"
            ? "PREPARING"
            : "FAILED",
        code,
      );
      return job.digest
        ? "UNKNOWN"
        : code === "GAS_RESERVED"
          ? "PREPARING"
          : "FAILED";
    }
  }
}
