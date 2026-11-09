import { projectCase } from "./case-state.js";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { tenantTransaction, type Database } from "./database.js";
import { DomainError } from "./errors.js";
import {
  actorSchema,
  authorizeOperator as authorize,
  type Actor,
} from "./authorization.js";
import {
  matchPayment,
  paymentEvidenceSchema,
  type PaymentGateway,
  type PaymentIntent,
  type PaymentEvidence,
} from "./payment.js";

const decisionBaseSchema = z
  .object({
    caseId: z.uuid(),
    caseVersion: z.number().int().positive(),
    policyVersion: z.number().int().positive(),
    kind: z.enum(["APPROVED", "REJECTED", "CORRECTED", "CANCELLED"]),
    reason: z.string().trim().min(8).max(500).optional(),
    correctionTarget: z
      .enum([
        "ORDER_DETAILS",
        "PAYMENT_DETAILS",
        "PRODUCT_ACCESS",
        "CUSTOMER_MESSAGE",
      ])
      .optional(),
  })
  .strict();

const validateDecision = (
  input: {
    kind: "APPROVED" | "REJECTED" | "CORRECTED" | "CANCELLED";
    reason?: string | undefined;
    correctionTarget?:
      | "ORDER_DETAILS"
      | "PAYMENT_DETAILS"
      | "PRODUCT_ACCESS"
      | "CUSTOMER_MESSAGE"
      | undefined;
  },
  context: z.RefinementCtx,
) => {
  if (input.kind === "CORRECTED" && !input.reason)
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "A correction reason is required",
    });
  if (input.kind === "CORRECTED" && !input.correctionTarget)
    context.addIssue({
      code: "custom",
      path: ["correctionTarget"],
      message: "Choose what needs correction",
    });
  if (input.kind !== "CORRECTED" && input.correctionTarget)
    context.addIssue({
      code: "custom",
      path: ["correctionTarget"],
      message: "A correction target is only valid for CORRECTED",
    });
};

export const decisionSchema = decisionBaseSchema.superRefine(validateDecision);
export const decisionRequestSchema = decisionBaseSchema
  .omit({ caseId: true })
  .superRefine(validateDecision);
export const repairSchema = z
  .object({
    caseId: z.uuid(),
    decisionId: z.uuid(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
type DecisionInput = z.infer<typeof decisionSchema>;
type RepairInput = z.infer<typeof repairSchema>;

async function loadCase(
  db: PoolClient,
  actor: Actor,
  caseId: string,
  lock = false,
) {
  const r = await db.query(
    `SELECT c.id,c.version,c.order_id,c.demo_role,o.product_id,p.network,p.expected_digest,p.sender,p.recipient,p.coin_type,p.amount::text,p.created_at,p.expires_at
    FROM morrow.cases c JOIN morrow.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id
    JOIN morrow.payment_intents p ON p.tenant_id=o.tenant_id AND p.order_id=o.id
    WHERE c.tenant_id=$1 AND c.id=$2 ${lock ? "FOR UPDATE OF c" : ""}`,
    [actor.tenantId, caseId],
  );
  const row = r.rows[0];
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row as {
    id: string;
    version: number;
    order_id: string;
    demo_role: "A" | "B" | "C" | null;
    product_id: string;
    network: "testnet";
    expected_digest: string;
    sender: string;
    recipient: string;
    coin_type: string;
    amount: string;
    created_at: Date;
    expires_at: Date;
  };
}
function intentOf(row: Awaited<ReturnType<typeof loadCase>>): PaymentIntent {
  return {
    network: row.network,
    expectedDigest: row.expected_digest,
    sender: row.sender,
    recipient: row.recipient,
    coinType: row.coin_type,
    amount: row.amount,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}
async function event(
  db: PoolClient,
  actor: Actor,
  caseId: string,
  kind: string,
  data: unknown,
) {
  await db.query(
    "INSERT INTO morrow.case_events(tenant_id,case_id,operator_id,kind,data) VALUES ($1,$2,$3,$4,$5)",
    [actor.tenantId, caseId, actor.operatorId, kind, JSON.stringify(data)],
  );
}

/** All effects are inside the approval transaction; provider calls happen before locks. */
export class ResolutionService {
  constructor(
    private readonly pool: Database,
    private readonly payment: PaymentGateway,
  ) {}

  private async context(actor: Actor, caseId: string) {
    actorSchema.parse(actor);
    z.uuid().parse(caseId);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      await authorize(db, actor);
      return loadCase(db, actor, caseId);
    });
  }

  private async evidence(digest: string): Promise<PaymentEvidence | null> {
    try {
      const data = paymentEvidenceSchema.parse(
        await this.payment.getTransaction(digest),
      );
      // A cached or future-dated gateway observation cannot authorize a current mutation.
      const age = Date.now() - Date.parse(data.checkedAt);
      if (age < -5000 || age > 60_000 || data.digest !== digest) return null;
      return data;
    } catch {
      return null;
    }
  }

  async investigate(actor: Actor, caseId: string) {
    const row = await this.context(actor, caseId);
    const evidence = await this.evidence(row.expected_digest);
    const result = evidence
      ? matchPayment(intentOf(row), evidence)
      : { verdict: "UNKNOWN" as const, reason: "PROVIDER_UNAVAILABLE" };
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      await authorize(db, actor);
      await loadCase(db, actor, caseId);
      const id = randomUUID();
      await db.query(
        "INSERT INTO morrow.payment_checks(tenant_id,id,case_id,verdict,reason,evidence) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          actor.tenantId,
          id,
          caseId,
          result.verdict,
          result.reason,
          JSON.stringify(evidence ?? {}),
        ],
      );
      await event(db, actor, caseId, "PAYMENT_CHECKED", {
        checkId: id,
        ...result,
      });
      return { id, ...result };
    });
  }

  async decide(actor: Actor, input: DecisionInput) {
    actorSchema.parse(actor);
    const req = decisionSchema.parse(input);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorize(db, actor);
      const row = await loadCase(db, actor, req.caseId, true);
      if (
        row.version !== req.caseVersion ||
        policy.policy_version !== req.policyVersion
      )
        throw new DomainError("STALE_REVIEW");
      if (req.kind === "APPROVED") {
        if (row.demo_role === "C") throw new DomainError("CASE_REFUSED", 409);
        if (!policy.grant_enabled) throw new DomainError("POLICY_DENIED", 403);
        const latest = await db.query(
          `SELECT verdict,checked_at FROM morrow.payment_checks WHERE tenant_id=$1 AND case_id=$2 ORDER BY checked_at DESC,id DESC LIMIT 1`,
          [actor.tenantId, req.caseId],
        );
        const check = latest.rows[0];
        if (
          !check ||
          check.verdict !== "MATCH" ||
          Date.now() - check.checked_at.getTime() > 60_000
        )
          throw new DomainError("PAYMENT_NOT_CONFIRMED");
        const entitled = await db.query(
          "SELECT 1 FROM morrow.entitlements WHERE tenant_id=$1 AND order_id=$2",
          [actor.tenantId, row.order_id],
        );
        if (entitled.rowCount) throw new DomainError("ALREADY_ENTITLED");
      }
      const id = randomUUID(),
        version = row.version + 1;
      await db.query(
        "INSERT INTO morrow.decisions(tenant_id,id,case_id,operator_id,kind,case_version,policy_version) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          actor.tenantId,
          id,
          req.caseId,
          actor.operatorId,
          req.kind,
          version,
          policy.policy_version,
        ],
      );
      await db.query(
        "UPDATE morrow.cases SET version=$3 WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, req.caseId, version],
      );
      await event(db, actor, req.caseId, req.kind, {
        decisionId: id,
        version,
        policyVersion: policy.policy_version,
        ...(req.reason ? { reason: req.reason } : {}),
        ...(req.correctionTarget
          ? { correctionTarget: req.correctionTarget }
          : {}),
      });
      return {
        id,
        kind: req.kind,
        caseVersion: version,
        policyVersion: policy.policy_version,
      };
    });
  }

  async repair(actor: Actor, input: RepairInput) {
    actorSchema.parse(actor);
    const req = repairSchema.parse(input);
    const snapshot = await this.context(actor, req.caseId);
    // Never trust the client or a previous investigation as the payment authority.
    const evidence = await this.evidence(snapshot.expected_digest);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          actor.tenantId,
          actor.operatorId,
          req.caseId,
          req.decisionId,
          "GRANT_ACCESS",
        ]),
      )
      .digest("hex");
    const outcome = await tenantTransaction(
      this.pool,
      actor.tenantId,
      async (db) => {
        const policy = await authorize(db, actor);
        const row = await loadCase(db, actor, req.caseId, true);
        if (row.demo_role === "C") throw new DomainError("CASE_REFUSED", 409);
        const prior = await db.query(
          "SELECT id,fingerprint FROM morrow.repairs WHERE tenant_id=$1 AND operator_id=$2 AND idempotency_key=$3",
          [actor.tenantId, actor.operatorId, req.idempotencyKey],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].fingerprint !== fingerprint)
            throw new DomainError("IDEMPOTENCY_CONFLICT");
          return {
            repairId: prior.rows[0].id as string,
            orderId: row.order_id,
            productId: row.product_id,
          };
        }
        const decision = await db.query(
          "SELECT kind,operator_id,case_version,policy_version FROM morrow.decisions WHERE tenant_id=$1 AND id=$2 AND case_id=$3",
          [actor.tenantId, req.decisionId, req.caseId],
        );
        const d = decision.rows[0];
        if (!d || d.kind !== "APPROVED" || d.operator_id !== actor.operatorId)
          throw new DomainError("APPROVAL_REQUIRED", 403);
        if (
          d.case_version !== row.version ||
          d.policy_version !== policy.policy_version
        )
          throw new DomainError("STALE_REVIEW");
        if (!policy.grant_enabled) throw new DomainError("POLICY_DENIED", 403);
        const matched = evidence
          ? matchPayment(intentOf(row), evidence)
          : { verdict: "UNKNOWN" as const };
        if (
          matched.verdict !== "MATCH" ||
          !evidence ||
          Date.now() - Date.parse(evidence.checkedAt) > 60_000
        )
          throw new DomainError("PAYMENT_NOT_CONFIRMED");
        const entitled = await db.query(
          "SELECT 1 FROM morrow.entitlements WHERE tenant_id=$1 AND order_id=$2",
          [actor.tenantId, row.order_id],
        );
        if (entitled.rowCount) throw new DomainError("ALREADY_ENTITLED");
        const id = randomUUID();
        await db.query(
          "INSERT INTO morrow.entitlements(tenant_id,order_id,product_id) VALUES ($1,$2,$3)",
          [actor.tenantId, row.order_id, row.product_id],
        );
        await db.query(
          "INSERT INTO morrow.repairs(tenant_id,id,case_id,decision_id,operator_id,idempotency_key,fingerprint,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'EXECUTED')",
          [
            actor.tenantId,
            id,
            req.caseId,
            req.decisionId,
            actor.operatorId,
            req.idempotencyKey,
            fingerprint,
          ],
        );
        await db.query(
          "UPDATE morrow.cases SET version=version+1 WHERE tenant_id=$1 AND id=$2",
          [actor.tenantId, req.caseId],
        );
        await event(db, actor, req.caseId, "REPAIR_EXECUTED", {
          repairId: id,
          decisionId: req.decisionId,
          digest: evidence.digest,
        });
        return {
          repairId: id,
          orderId: row.order_id,
          productId: row.product_id,
        };
      },
    );
    // Commit acknowledgement is insufficient: confirm persisted access on a separate acquisition.
    try {
      const access = await this.inspect(actor, req.caseId);
      if (!access.entitled) throw new DomainError("READBACK_FAILED", 503);
      return {
        repairId: outcome.repairId,
        status: "READBACK_CONFIRMED" as const,
      };
    } catch {
      throw new DomainError("READBACK_UNKNOWN", 503);
    }
  }

  async inspect(actor: Actor, caseId: string) {
    actorSchema.parse(actor);
    z.uuid().parse(caseId);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorize(db, actor);
      const row = await loadCase(db, actor, caseId);
      const access = await db.query(
        "SELECT granted_at FROM morrow.entitlements WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3",
        [actor.tenantId, row.order_id, row.product_id],
      );
      const events = await db.query(
        "SELECT id,kind,data,created_at FROM morrow.case_events WHERE tenant_id=$1 AND case_id=$2 ORDER BY id LIMIT 100",
        [actor.tenantId, caseId],
      );
      const payment = await db.query(
        "SELECT verdict,reason,checked_at FROM morrow.payment_checks WHERE tenant_id=$1 AND case_id=$2 ORDER BY checked_at DESC,id DESC LIMIT 1",
        [actor.tenantId, caseId],
      );
      const repair = await db.query(
        "SELECT id,created_at FROM morrow.repairs WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 1",
        [actor.tenantId, caseId],
      );
      const lessons = await db.query(
        "SELECT id,state,network,job_id,blob_id,recalled_at FROM morrow.lessons WHERE tenant_id=$1 AND case_id=$2 ORDER BY recalled_at DESC NULLS LAST LIMIT 10",
        [actor.tenantId, caseId],
      );
      const decision = await db.query(
        "SELECT kind,case_version,policy_version FROM morrow.decisions WHERE tenant_id=$1 AND case_id=$2 ORDER BY case_version DESC LIMIT 1",
        [actor.tenantId, caseId],
      );
      return {
        caseId,
        summary: projectCase(
          {
            payment: {
              verdict: payment.rows[0]?.verdict ?? "NOT_CHECKED",
              checkedAt: payment.rows[0]?.checked_at,
            },
            intentExpiresAt: row.expires_at,
            decision: decision.rows[0]
              ? {
                  kind: decision.rows[0].kind,
                  current:
                    decision.rows[0].case_version === row.version &&
                    decision.rows[0].policy_version === policy.policy_version,
                }
              : null,
            policyEnabled: policy.grant_enabled,
            entitled: access.rowCount === 1,
            executed: !!repair.rows[0],
          },
          actor.role === "judge" ? "demo" : "merchant",
        ),
        caseVersion: row.version,
        policyVersion: policy.policy_version,
        entitled: access.rowCount === 1,
        payment: payment.rows[0] ?? null,
        repair: repair.rows[0] ?? null,
        lessons: lessons.rows,
        events: events.rows,
      };
    });
  }
}
