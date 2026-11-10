import type { FairComparisonService } from "./fair.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tenantTransaction, type Database } from "./database.js";
import { authorizeOperator, type Actor } from "./authorization.js";
import { DomainError } from "./errors.js";
import { MerchantService } from "./merchant.js";
import { LessonService } from "./lessons.js";
import { lessonSchema, describeLesson, classifyMemoryJob } from "./memory.js";
import type { ScopedMemory } from "./lesson-factory.js";
import type { ResolutionService } from "./resolution.js";
import type { DemoProvisioningService } from "./demo-provisioning.js";
import type { InvestigationService } from "./investigation.js";

const procedure = lessonSchema.shape.procedure;
export const draftUpdateSchema = z
  .object({
    version: z.number().int().positive(),
    procedure,
    applicableCategories: z
      .array(z.enum(["course", "download"]))
      .min(1)
      .max(2),
  })
  .strict();
const DEFAULT_PROCEDURE = [
  "VERIFY_CURRENT_ORDER",
  "VERIFY_PAYMENT_INTENT",
  "CHECK_CURRENT_POLICY",
  "CHECK_PERSISTED_ACCESS",
  "REQUEST_MERCHANT_APPROVAL",
  "GRANT_IDEMPOTENTLY",
  "CONFIRM_READBACK",
  "ESCALATE_UNKNOWN",
];
/** Isolated A/B workflow. No client-controlled tenant, target order or payment. */
export class DemoJourneyService {
  constructor(
    private readonly pool: Database,
    private readonly resolution: ResolutionService,
    private readonly provisioning: DemoProvisioningService,
    private readonly investigation: InvestigationService,
    private readonly memoryFor: (tenantId: string) => ScopedMemory | null,
    private readonly fair?: FairComparisonService,
  ) {}
  private async run(actor: Actor, key: string) {
    if (actor.role !== "judge") throw new DomainError("FORBIDDEN", 403);
    return this.provisioning.recover(actor, key);
  }
  async view(actor: Actor, key: string) {
    const run = await this.run(actor, key),
      merchant = new MerchantService(this.pool);
    const a = await merchant.detail(actor, run.caseId),
      b = await merchant.detail(actor, run.caseBId),
      c = await merchant.detail(actor, run.caseCId);
    const data = await tenantTransaction(
      this.pool,
      actor.tenantId,
      async (db) => {
        await authorizeOperator(db, actor);
        return {
          jobs: (
            await db.query(
              "SELECT role,state,error_code,lease_until,not_before FROM morrow.demo_payment_jobs WHERE tenant_id=$1",
              [actor.tenantId],
            )
          ).rows,
          investigation:
            (
              await db.query(
                "SELECT state,lease_until FROM morrow.investigation_runs WHERE tenant_id=$1 AND case_id=$2 AND case_version=$3 AND policy_version=$4 ORDER BY lease_until DESC LIMIT 1",
                [
                  actor.tenantId,
                  run.caseId,
                  a.caseVersion,
                  a.policy.policyVersion,
                ],
              )
            ).rows[0] ?? null,
          draft:
            (
              await db.query(
                "SELECT version,payload,approved_lesson_id,approval_state FROM morrow.demo_lesson_drafts WHERE tenant_id=$1 AND case_id=$2",
                [actor.tenantId, run.caseId],
              )
            ).rows[0] ?? null,
          lessonJobs: (
            await db.query(
              "SELECT lesson_id,state,error_code FROM morrow.demo_lesson_jobs WHERE tenant_id=$1",
              [actor.tenantId],
            )
          ).rows,
          baseline:
            (
              await db.query(
                "SELECT state,off_result,result,error_code,lease_until FROM morrow.comparison_baselines WHERE tenant_id=$1 AND source_case_id=$2 AND target_case_id=$3 AND operation_key='guided'",
                [actor.tenantId, run.caseId, run.caseBId],
              )
            ).rows[0] ?? null,
          comparison:
            (
              await db.query(
                "SELECT id,data,created_at FROM morrow.case_events WHERE tenant_id=$1 AND case_id=$2 AND kind='COMPARISON_RUN' ORDER BY id DESC LIMIT 1",
                [actor.tenantId, run.caseBId],
              )
            ).rows[0] ?? null,
        };
      },
    );
    const proposal =
      a.events.find(
        (e) =>
          e.kind === "AGENT_RECOMMENDATION" &&
          e.data.caseVersion === a.caseVersion &&
          e.data.policyVersion === a.policy.policyVersion,
      )?.data ?? null;
    const lesson = a.lessons[0] ?? null;
    const jobA = data.jobs.find((j) => j.role === "A");
    const currentDecision = a.decisions.find(
      (d) =>
        d.case_version === a.caseVersion &&
        d.policy_version === a.policy.policyVersion,
    );
    const investigating =
      data.investigation?.state === "RUNNING" &&
      new Date(data.investigation.lease_until).getTime() > Date.now();
    const stage =
      !a.policy.grantEnabled ||
      (lesson && lesson.policy_version !== a.policy.policyVersion)
        ? "POLICY_BLOCKED"
        : lesson?.state === "RECALL_VERIFIED"
          ? "A_COMPLETE"
          : lesson?.state === "COMPLETED"
            ? "RECALL_PENDING"
            : lesson
              ? "STORING"
              : a.summary.access === "CONFIRMED" &&
                  a.summary.execution === "COMMITTED"
                ? "DRAFT_READY"
                : a.summary.execution === "COMMITTED"
                  ? "READBACK_UNKNOWN"
                  : currentDecision?.kind === "REJECTED"
                    ? "DECLINED"
                    : currentDecision?.kind === "APPROVED"
                      ? "APPROVED"
                      : a.summary.allowed.approve && proposal
                        ? "REVIEW_READY"
                        : a.summary.payment.fresh && a.paymentAttested
                          ? investigating
                            ? "INVESTIGATING"
                            : "INVESTIGATION_READY"
                          : jobA?.state === "FAILED" ||
                              jobA?.state === "CANCELLED"
                            ? "PAYMENT_ERROR"
                            : "PAYMENT_PENDING";
    return {
      stage,
      investigating,
      caseA: {
        caseId: run.caseId,
        caseVersion: a.caseVersion,
        policyVersion: a.policy.policyVersion,
        summary: a.summary,
        proposal,
        decision: currentDecision ?? null,
        lesson,
        repairDecisionId: a.repairs[0]?.decision_id ?? null,
      },
      caseB: { caseId: run.caseBId, summary: b.summary },
      caseC: {
        caseId: run.caseCId,
        summary: c.summary,
        evidence: c.evidence,
        access: c.access,
        repairs: c.repairs,
        decisions: c.decisions,
      },
      jobs: data.jobs.map(({ lease_until, not_before, ...j }) => ({
        ...j,
        working: !!lease_until && new Date(lease_until).getTime() > Date.now(),
      })),
      draft: data.draft,
      lessonJobs: data.lessonJobs,
      comparison: data.comparison,
      baseline: data.baseline,
      scenario: { A: a.scenario, B: b.scenario },
      nextAction:
        stage === "POLICY_BLOCKED"
          ? "BLOCKED"
          : stage === "INVESTIGATING"
            ? "PENDING"
            : ["STORING", "RECALL_PENDING"].includes(stage)
              ? "STORAGE"
              : stage === "A_COMPLETE"
                ? "OPEN_B"
                : stage === "DRAFT_READY"
                  ? "LESSON"
                  : stage === "REVIEW_READY"
                    ? "REVIEW"
                    : stage === "APPROVED" || stage === "READBACK_UNKNOWN"
                      ? "REPAIR"
                      : stage === "INVESTIGATION_READY"
                        ? "INVESTIGATE"
                        : stage === "PAYMENT_PENDING"
                          ? "CHECK"
                          : stage === "PAYMENT_ERROR"
                            ? "RETRY_PAYMENT"
                            : stage === "DECLINED"
                              ? "DECLINED"
                              : "WAIT",
    };
  }
  async check(actor: Actor, key: string) {
    const run = await this.run(actor, key);
    const job = await tenantTransaction(
      this.pool,
      actor.tenantId,
      async (db) =>
        (
          await db.query(
            "SELECT state,digest FROM morrow.demo_payment_jobs WHERE tenant_id=$1 AND case_id=$2",
            [actor.tenantId, run.caseId],
          )
        ).rows[0],
    );
    if (!job?.digest || !["CONFIRMED", "UNKNOWN"].includes(job.state))
      return this.view(actor, key);
    const check = await this.resolution.investigate(actor, run.caseId);
    if (check.verdict === "MATCH" && job.state !== "CONFIRMED")
      await tenantTransaction(this.pool, actor.tenantId, (db) =>
        db.query(
          "UPDATE morrow.demo_payment_jobs SET state='CONFIRMED',error_code=NULL,lease_until=NULL WHERE tenant_id=$1 AND case_id=$2",
          [actor.tenantId, run.caseId],
        ),
      );
    return this.view(actor, key);
  }
  async startC(actor: Actor, key: string) {
    const run = await this.run(actor, key);
    const state = await this.view(actor, key);
    if (
      state.stage !== "A_COMPLETE" ||
      state.jobs.find((job) => job.role === "B")?.state !== "CONFIRMED" ||
      state.baseline?.state !== "COMPLETE" ||
      !state.baseline.result
    )
      throw new DomainError("CASE_B_REQUIRED", 409);
    await tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorizeOperator(db, actor);
      if (!policy.grant_enabled) throw new DomainError("POLICY_DENIED", 403);
      const ready = await db.query(
        `SELECT 1 FROM morrow.demo_payment_jobs b
         JOIN morrow.comparison_baselines x ON x.tenant_id=b.tenant_id AND x.target_case_id=b.case_id
         JOIN morrow.lessons l ON l.tenant_id=x.tenant_id AND l.case_id=x.source_case_id
         WHERE b.tenant_id=$1 AND b.case_id=$2 AND b.role='B' AND b.state='CONFIRMED'
           AND x.source_case_id=$3 AND x.state='COMPLETE' AND x.result IS NOT NULL
           AND l.state='RECALL_VERIFIED' AND l.policy_version=$4`,
        [actor.tenantId, run.caseBId, run.caseId, policy.policy_version],
      );
      if (!ready.rowCount) throw new DomainError("CASE_B_REQUIRED", 409);
      await db.query(
        `INSERT INTO morrow.demo_payment_jobs(tenant_id,case_id,operator_id,role)
         VALUES($1,$2,$3,'C') ON CONFLICT DO NOTHING`,
        [actor.tenantId, run.caseCId, actor.operatorId],
      );
    });
    return this.view(actor, key);
  }
  async checkC(actor: Actor, key: string) {
    const run = await this.run(actor, key);
    const job = await tenantTransaction(
      this.pool,
      actor.tenantId,
      async (db) => {
        await authorizeOperator(db, actor);
        return (
          await db.query(
            "SELECT state FROM morrow.demo_payment_jobs WHERE tenant_id=$1 AND case_id=$2 AND role='C'",
            [actor.tenantId, run.caseCId],
          )
        ).rows[0];
      },
    );
    if (!job || !["UNKNOWN", "MISMATCH", "CONFIRMED"].includes(job.state))
      throw new DomainError("CASE_C_PAYMENT_PENDING", 409);
    const check = await this.resolution.investigate(actor, run.caseCId);
    const state = check.verdict === "MISMATCH" ? "MISMATCH" : "UNKNOWN";
    await tenantTransaction(this.pool, actor.tenantId, async (db) => {
      await authorizeOperator(db, actor);
      await db.query(
        `UPDATE morrow.demo_payment_jobs SET state=$3,error_code=$4,lease_until=NULL,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND case_id=$2 AND role='C'`,
        [
          actor.tenantId,
          run.caseCId,
          state,
          state === "MISMATCH"
            ? "PAYMENT_MISMATCH"
            : check.verdict === "MATCH"
              ? "UNEXPECTED_CASE_C_MATCH"
              : "PROVIDER_UNAVAILABLE",
        ],
      );
    });
    return this.view(actor, key);
  }
  async proof(actor: Actor, key: string) {
    const state = await this.view(actor, key);
    const run = await this.run(actor, key);
    const merchant = new MerchantService(this.pool);
    const [a, b, c] = await Promise.all([
      merchant.detail(actor, run.caseId),
      merchant.detail(actor, run.caseBId),
      merchant.detail(actor, run.caseCId),
    ]);
    const latest = (detail: typeof a) => detail.evidence.latestCheck;
    const lesson = a.lessons[0] ?? null;
    const baseline = state.baseline?.result;
    const result =
      typeof baseline === "string" ? JSON.parse(baseline) : baseline;
    const comparison = result?.comparison ?? null;
    const cCheck = latest(c);
    const cEvidence = cCheck?.evidence ?? {};
    const actualAmount = Array.isArray(cEvidence.balanceChanges)
      ? (cEvidence.balanceChanges.find(
          (change: { address?: string; amount?: string }) => {
            if (
              change.address !== c.evidence.intent?.recipient ||
              typeof change.amount !== "string" ||
              !/^-?[0-9]{1,30}$/.test(change.amount)
            )
              return false;
            return BigInt(change.amount) > 0n;
          },
        )?.amount ?? null)
      : null;
    const safeC =
      cCheck?.verdict === "MISMATCH" &&
      cEvidence.status === "SUCCESS" &&
      c.repairs.length === 0 &&
      c.access === "MISSING";
    return {
      network: "testnet",
      generatedAt: new Date().toISOString(),
      a: {
        status:
          latest(a)?.verdict === "MATCH" &&
          a.repairs.length > 0 &&
          a.access === "RESTORED"
            ? "PASS"
            : "UNVERIFIED",
        payment: {
          verdict: latest(a)?.verdict ?? "NOT_CHECKED",
          network: a.evidence.intent?.network ?? "testnet",
          checkedAt: latest(a)?.checkedAt ?? null,
          digest: a.evidence.intent?.digest ?? null,
        },
        repair: {
          state: a.repairs.length ? "EXECUTED" : "NOT_RECORDED",
          repairId: a.repairs[0]?.id ?? null,
        },
        entitlement: {
          before: "MISSING",
          after: a.access,
          readBackAt: a.entitledAt,
        },
        lesson: lesson
          ? {
              state: lesson.state,
              network: lesson.network,
              jobId: lesson.job_id,
              blobId: lesson.blob_id,
              recalledAt: lesson.recalled_at,
            }
          : null,
      },
      b: {
        state: state.baseline?.state ?? "NOT_RUN",
        outcome: comparison?.outcome ?? "INCONCLUSIVE",
        readOnly: comparison?.readOnly === true,
        snapshotHash: comparison?.snapshotHash ?? null,
        off: {
          steps: result?.off?.metrics?.steps ?? null,
          lessons: result?.off?.metrics?.lessonsConsidered ?? 0,
          action: result?.off?.proposal?.action ?? null,
          reason: result?.off?.proposal?.reason ?? null,
        },
        on: {
          steps: result?.on?.metrics?.steps ?? null,
          lessons: result?.on?.metrics?.lessonsConsidered ?? 0,
          action: result?.on?.proposal?.action ?? null,
          reason: result?.on?.proposal?.reason ?? null,
          recall: result?.on?.recall?.status ?? "NOT_RUN",
          network: result?.on?.recall?.network ?? null,
        },
      },
      c: {
        status: safeC
          ? "PASS"
          : !cCheck || cCheck.verdict === "UNKNOWN"
            ? "UNVERIFIED"
            : "FAIL",
        payment: {
          verdict: cCheck?.verdict ?? "NOT_CHECKED",
          reason: cCheck?.reason ?? null,
          network: c.evidence.intent?.network ?? "testnet",
          successfulTransaction: cEvidence.status === "SUCCESS",
          checkedAt: cCheck?.checkedAt ?? null,
          expectedAmountMist: c.evidence.intent?.amount ?? null,
          observedAmountMist: actualAmount,
          digest: c.evidence.intent?.digest ?? null,
        },
        entitlement: { before: "MISSING", after: c.access },
        repairs: c.repairs.length,
      },
      mainnet: { status: "DEFERRED", memories: 0, required: 10 },
    };
  }
  async propose(actor: Actor, key: string) {
    const run = await this.run(actor, key);
    await this.investigation.recommend(actor, run.caseId);
    return this.view(actor, key);
  }
  async decide(
    actor: Actor,
    key: string,
    input: {
      kind: "APPROVED" | "REJECTED";
      caseVersion: number;
      policyVersion: number;
    },
  ) {
    const run = await this.run(actor, key);
    return this.resolution.decide(actor, { ...input, caseId: run.caseId });
  }
  async repair(actor: Actor, key: string, decisionId: string) {
    const run = await this.run(actor, key);
    return this.resolution.repair(actor, {
      caseId: run.caseId,
      decisionId,
      idempotencyKey: `demo-${decisionId}`,
    });
  }
  private async payload(actor: Actor, key: string) {
    const run = await this.run(actor, key);
    const detail = await new MerchantService(this.pool).detail(
      actor,
      run.caseId,
    );
    if (!detail.summary.allowed.createLesson)
      throw new DomainError("REPAIR_NOT_CONFIRMED", 409);
    return {
      run,
      detail,
      payload: lessonSchema.parse({
        sourceCaseId: run.caseId,
        policyVersion: detail.policy.policyVersion,
        productCategory: "course",
        applicableCategories: ["course", "download"],
        problem: "PAID_ACCESS_MISSING",
        procedure: DEFAULT_PROCEDURE,
        outcome: "READBACK_CONFIRMED",
        fictional: true,
      }),
    };
  }
  async openDraft(actor: Actor, key: string) {
    const { run, payload } = await this.payload(actor, key);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      await authorizeOperator(db, actor);
      await db.query(
        "INSERT INTO morrow.demo_lesson_drafts(tenant_id,case_id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING",
        [actor.tenantId, run.caseId, JSON.stringify(payload)],
      );
      return (
        await db.query(
          "SELECT version,payload,approval_state,approved_lesson_id FROM morrow.demo_lesson_drafts WHERE tenant_id=$1 AND case_id=$2",
          [actor.tenantId, run.caseId],
        )
      ).rows[0];
    });
  }
  async saveDraft(
    actor: Actor,
    key: string,
    input: z.infer<typeof draftUpdateSchema>,
  ) {
    const body = draftUpdateSchema.parse(input),
      { run, payload } = await this.payload(actor, key);
    const next = lessonSchema.parse({
      ...payload,
      procedure: body.procedure,
      applicableCategories: body.applicableCategories,
    });
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      await authorizeOperator(db, actor);
      const saved = await db.query(
        "UPDATE morrow.demo_lesson_drafts SET payload=$4::jsonb,version=version+1 WHERE tenant_id=$1 AND case_id=$2 AND version=$3 AND approval_state='DRAFT' AND approved_lesson_id IS NULL RETURNING version,payload,approval_state",
        [actor.tenantId, run.caseId, body.version, JSON.stringify(next)],
      );
      if (!saved.rowCount) throw new DomainError("STALE_DRAFT", 409);
      return saved.rows[0];
    });
  }
  async approveLesson(actor: Actor, key: string, version: number) {
    const { run } = await this.payload(actor, key);
    const scope = this.memoryFor(actor.tenantId);
    if (!scope) throw new DomainError("MEMORY_UNAVAILABLE", 503);
    const claim = randomUUID();
    let draft;
    try {
      draft = await tenantTransaction(this.pool, actor.tenantId, async (db) => {
        await authorizeOperator(db, actor);
        const row = (
          await db.query(
            "SELECT * FROM morrow.demo_lesson_drafts WHERE tenant_id=$1 AND case_id=$2 FOR UPDATE",
            [actor.tenantId, run.caseId],
          )
        ).rows[0];
        if (!row || row.version !== version)
          throw new DomainError("STALE_DRAFT", 409);
        if (row.approved_lesson_id) return row;
        if (
          row.approval_state === "APPROVING" &&
          row.approval_lease_until > new Date()
        )
          throw new DomainError("LESSON_BUSY", 409);
        await db.query(
          "UPDATE morrow.demo_lesson_drafts SET approval_state='APPROVING',approval_claim=$3,approval_lease_until=clock_timestamp()+interval '90 seconds' WHERE tenant_id=$1 AND case_id=$2",
          [actor.tenantId, run.caseId, claim],
        );
        return row;
      });
    } catch (error) {
      scope.close();
      throw error;
    }
    try {
      if (draft.approved_lesson_id)
        return { id: draft.approved_lesson_id, state: "APPROVED" };
      const payload = lessonSchema.parse(draft.payload);
      let id: string;
      try {
        id = (
          await new LessonService(
            this.pool,
            scope.tenantConfig,
            scope.gateway,
          ).approve(actor, payload)
        ).id;
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          error.code !== "LESSON_ALREADY_APPROVED"
        )
          throw error;
        id = await tenantTransaction(
          this.pool,
          actor.tenantId,
          async (db) =>
            (
              await db.query(
                "SELECT id FROM morrow.lessons WHERE tenant_id=$1 AND case_id=$2 AND content_hash=$3",
                [
                  actor.tenantId,
                  run.caseId,
                  describeLesson(payload).contentHash,
                ],
              )
            ).rows[0]?.id,
        );
        if (!id) throw error;
      }
      await tenantTransaction(this.pool, actor.tenantId, async (db) => {
        await authorizeOperator(db, actor);
        await db.query(
          "UPDATE morrow.demo_lesson_drafts SET approval_state='APPROVED',approved_lesson_id=$4 WHERE tenant_id=$1 AND case_id=$2 AND approval_claim=$3",
          [actor.tenantId, run.caseId, claim, id],
        );
      });
      return { id, state: "APPROVED" };
    } catch (error) {
      await tenantTransaction(this.pool, actor.tenantId, (db) =>
        db.query(
          "UPDATE morrow.demo_lesson_drafts SET approval_state='DRAFT' WHERE tenant_id=$1 AND case_id=$2 AND approval_claim=$3 AND approved_lesson_id IS NULL",
          [actor.tenantId, run.caseId, claim],
        ),
      );
      throw error;
    } finally {
      scope.close();
    }
  }
  async retryStorage(actor: Actor, key: string) {
    const run = await this.run(actor, key),
      scope = this.memoryFor(actor.tenantId);
    if (!scope) throw new DomainError("MEMORY_UNAVAILABLE", 503);
    try {
      const row = await tenantTransaction(
        this.pool,
        actor.tenantId,
        async (db) => {
          const policy = await authorizeOperator(db, actor);
          if (!policy.grant_enabled)
            throw new DomainError("POLICY_DENIED", 403);
          const row = (
            await db.query(
              "SELECT l.*,j.retries FROM morrow.lessons l JOIN morrow.demo_lesson_jobs j ON j.tenant_id=l.tenant_id AND j.lesson_id=l.id WHERE l.tenant_id=$1 AND l.case_id=$2 AND j.state='FAILED' ORDER BY l.created_at DESC LIMIT 1",
              [actor.tenantId, run.caseId],
            )
          ).rows[0];
          if (!row || row.retries >= 3)
            throw new DomainError("MEMORY_RETRY_LIMIT", 429);
          if (row.policy_version !== policy.policy_version)
            throw new DomainError("STALE_POLICY", 409);
          return row;
        },
      );
      if (row.state === "FAILED") {
        const observed = classifyMemoryJob(
          await scope.gateway.status(row.job_id),
        );
        if (observed.state !== "FAILED" || observed.jobId !== row.job_id)
          throw new DomainError("MEMORY_RECONCILE_REQUIRED", 409);
      }
      await tenantTransaction(this.pool, actor.tenantId, async (db) => {
        await authorizeOperator(db, actor);
        const claimed = await db.query(
          "UPDATE morrow.demo_lesson_jobs SET retries=retries+1,attempts=0,state='QUEUED',lease_until=NULL,error_code=NULL,not_before=clock_timestamp() WHERE tenant_id=$1 AND lesson_id=$2 AND state='FAILED' AND retries<3 RETURNING lesson_id",
          [actor.tenantId, row.id],
        );
        if (!claimed.rowCount) throw new DomainError("LESSON_BUSY", 409);
        if (row.state === "FAILED") {
          const reset = await db.query(
            "UPDATE morrow.lessons SET state='APPROVED',job_id=NULL,blob_id=NULL,completed_at=NULL,recalled_at=NULL,submission_attempt=submission_attempt+1 WHERE tenant_id=$1 AND id=$2 AND state='FAILED' AND submission_attempt<3",
            [actor.tenantId, row.id],
          );
          if (!reset.rowCount) throw new DomainError("MEMORY_RETRY_LIMIT", 429);
        }
      });
      return this.view(actor, key);
    } finally {
      scope.close();
    }
  }
  async compare(actor: Actor, key: string, mode: "OFF" | "ON") {
    const run = await this.run(actor, key);
    if (!this.fair) throw new DomainError("FAIR_UNAVAILABLE", 503);
    const state = await this.view(actor, key);
    if (state.stage !== "A_COMPLETE")
      throw new DomainError("CASE_A_REQUIRED", 409);
    if (!state.jobs.some((j) => j.role === "B" && j.state === "CONFIRMED"))
      throw new DomainError("PAYMENT_NOT_CONFIRMED", 409);
    await (mode === "OFF"
      ? this.fair.start(actor, run.caseId, run.caseBId)
      : this.fair.finish(actor, run.caseId, run.caseBId));
    return this.view(actor, key);
  }
  async startB(actor: Actor, key: string) {
    const run = await this.run(actor, key);
    await tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorizeOperator(db, actor);
      const ready = await db.query(
        "SELECT 1 FROM morrow.lessons WHERE tenant_id=$1 AND case_id=$2 AND state='RECALL_VERIFIED' AND policy_version=$3",
        [actor.tenantId, run.caseId, policy.policy_version],
      );
      if (!ready.rowCount) throw new DomainError("CASE_A_REQUIRED", 409);
      await db.query(
        "INSERT INTO morrow.demo_payment_jobs(tenant_id,case_id,operator_id,role) VALUES($1,$2,$3,'B') ON CONFLICT DO NOTHING",
        [actor.tenantId, run.caseBId, actor.operatorId],
      );
    });
    return this.view(actor, key);
  }
}
