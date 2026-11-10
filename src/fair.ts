import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { tenantTransaction, type Database } from "./database.js";
import { DomainError } from "./errors.js";
import {
  actorSchema,
  authorizeOperator as authorize,
  type Actor,
} from "./authorization.js";
import type { ResolutionService } from "./resolution.js";
import { lessonSchema } from "./memory.js";
import { configuredPlanner, type AgentPlanner } from "./agent.js";
import type { ScopedMemory } from "./lesson-factory.js";

/**
 * S9 fair memory comparison.
 * run() is an explicitly labelled SQL-backed simulation.
 * compare() is the genuine B3 comparator: same frozen target snapshot for
 * both arms, A as the only lesson source, a real read-only investigation
 * per arm, and fresh ON recall with provenance. Neither arm grants,
 * repairs, approves or writes memory.
 */
export const fairPlanSchema = z.array(z.string()).max(12);

const BASE_STEPS = [
  "VERIFY_CURRENT_ORDER",
  "VERIFY_PAYMENT_INTENT",
  "CHECK_CURRENT_POLICY",
  "CHECK_PERSISTED_ACCESS",
  "REQUEST_MERCHANT_APPROVAL",
  "GRANT_IF_APPROVED",
  "CONFIRM_READBACK",
] as const;

export class FairComparisonService {
  constructor(
    private readonly pool: Database,
    private readonly resolution?: ResolutionService,
    private readonly memoryFor?: (tenantId: string) => ScopedMemory | null,
    private readonly agent: {
      name: string;
      planner: AgentPlanner;
    } = configuredPlanner({}),
  ) {}

  private async planFor(
    db: import("pg").PoolClient,
    actor: Actor,
    policyVersion: number,
    mode: "OFF" | "ON",
    operationKey = "guided",
  ) {
    const lessons =
      mode === "ON" ? await this.eligibleLessons(db, actor, policyVersion) : [];
    const plan: string[] = [...BASE_STEPS];
    if (mode === "ON") {
      for (const lesson of lessons) {
        for (const step of lesson.procedure) {
          if (!plan.includes(step)) plan.push(step);
        }
      }
    }
    const metrics = {
      mode,
      lessonsConsidered: lessons.length,
      steps: plan.length,
      guidance:
        mode === "ON"
          ? lessons.length + " approved lesson(s) informed this plan"
          : "No lesson guidance used.",
    };
    return { plan, metrics };
  }

  async run(actor: Actor, caseId: string, mode: "OFF" | "ON") {
    actorSchema.parse(actor);
    z.uuid().parse(caseId);
    if (mode !== "OFF" && mode !== "ON")
      throw new DomainError("INVALID_MODE", 400);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorize(db, actor);
      const c = await db.query(
        `SELECT c.id, c.version FROM morrow.cases c WHERE c.tenant_id=$1 AND c.id=$2`,
        [actor.tenantId, caseId],
      );
      if (!c.rows[0]) throw new DomainError("CASE_NOT_FOUND", 404);
      const { plan, metrics } = await this.planFor(
        db,
        actor,
        policy.policy_version,
        mode,
      );
      await db.query(
        `INSERT INTO morrow.case_events(tenant_id,case_id,operator_id,kind,data) VALUES ($1,$2,$3,'SIMULATION_RUN',$4::jsonb)`,
        [
          actor.tenantId,
          caseId,
          actor.operatorId,
          JSON.stringify({
            mode,
            plan,
            metrics,
            readOnly: true,
            simulation: true,
          }),
        ],
      );
      return { caseId, mode, plan, metrics, simulation: true as const };
    });
  }

  // Capture actual immutable input values, not just a label for live reads.
  private async snapshot(actor: Actor, source: string, target: string) {
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorize(db, actor);
      const rows = await db.query(
        `SELECT c.id,c.version,c.order_id,o.product_id,o.product_category,p.network,p.expected_digest,p.sender,p.recipient,p.coin_type,p.amount::text,p.created_at,p.expires_at,
        EXISTS(SELECT 1 FROM morrow.entitlements e WHERE e.tenant_id=c.tenant_id AND e.order_id=c.order_id AND e.product_id=o.product_id) AS entitled
        FROM morrow.cases c JOIN morrow.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id
        JOIN morrow.payment_intents p ON p.tenant_id=c.tenant_id AND p.order_id=c.order_id
        WHERE c.tenant_id=$1 AND c.id IN ($2,$3) ORDER BY c.id`,
        [actor.tenantId, source, target],
      );
      if (rows.rows.length !== 2) throw new DomainError("CASE_NOT_FOUND", 404);
      const data = {
        policyVersion: policy.policy_version,
        grantEnabled: policy.grant_enabled,
        cases: rows.rows,
      };
      return {
        ...data,
        snapshotHash: createHash("sha256")
          .update(JSON.stringify(data))
          .digest("hex"),
      };
    });
  }
  async compare(actor: Actor, caseAId: string, caseBId: string) {
    const operationKey = randomUUID();
    const off = await this.execute(
      actor,
      caseAId,
      caseBId,
      "OFF",
      operationKey,
    );
    if (off.state === "COMPLETE") return off.result;
    return (await this.execute(actor, caseAId, caseBId, "ON", operationKey))
      .result;
  }
  async start(actor: Actor, caseAId: string, caseBId: string) {
    return this.execute(actor, caseAId, caseBId, "OFF");
  }
  async finish(actor: Actor, caseAId: string, caseBId: string) {
    return this.execute(actor, caseAId, caseBId, "ON");
  }
  private async execute(
    actor: Actor,
    caseAId: string,
    caseBId: string,
    mode: "OFF" | "ON",
    operationKey = "guided",
  ) {
    actorSchema.parse(actor);
    z.uuid().parse(caseAId);
    z.uuid().parse(caseBId);
    if (caseAId === caseBId)
      throw new DomainError("COMPARISON_CASES_MUST_DIFFER", 400);
    if (!this.resolution || !this.memoryFor)
      throw new DomainError("FAIR_UNAVAILABLE", 503);
    const scoped = this.memoryFor(actor.tenantId);
    if (!scoped) throw new DomainError("FAIR_UNAVAILABLE", 503);
    const claim = randomUUID();
    let claimed = false;
    try {
      const operation = await tenantTransaction(
        this.pool,
        actor.tenantId,
        async (db) => {
          await authorize(db, actor);
          // Both cases must belong to this actor before a comparison row is visible.
          const cases = await db.query(
            "SELECT id FROM morrow.cases WHERE tenant_id=$1 AND id IN ($2,$3)",
            [actor.tenantId, caseAId, caseBId],
          );
          if (cases.rowCount !== 2)
            throw new DomainError("CASE_NOT_FOUND", 404);
          if (mode === "OFF")
            await db.query(
              "INSERT INTO morrow.comparison_baselines(tenant_id,source_case_id,target_case_id,planner,operation_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
              [actor.tenantId, caseAId, caseBId, this.agent.name, operationKey],
            );
          const row = (
            await db.query(
              "SELECT * FROM morrow.comparison_baselines WHERE tenant_id=$1 AND source_case_id=$2 AND target_case_id=$3 AND operation_key=$4 FOR UPDATE",
              [actor.tenantId, caseAId, caseBId, operationKey],
            )
          ).rows[0];
          if (!row) throw new DomainError("BASELINE_REQUIRED", 409);
          if (row.planner !== this.agent.name)
            throw new DomainError("COMPARISON_MODEL_CHANGED", 409);
          if (row.state === "COMPLETE" || (mode === "OFF" && row.off_result))
            return row;
          if (mode === "ON" && !row.off_result)
            throw new DomainError("BASELINE_REQUIRED", 409);
          if (
            row.lease_until &&
            new Date(row.lease_until).getTime() > Date.now()
          )
            throw new DomainError("COMPARISON_BUSY", 409);
          if (row.attempts >= 6)
            throw new DomainError("COMPARISON_RETRY_LIMIT", 429);
          await db.query(
            "UPDATE morrow.comparison_baselines SET claim=$4,lease_until=clock_timestamp()+interval '90 seconds',state=$5,attempts=attempts+1,error_code=NULL WHERE tenant_id=$1 AND source_case_id=$2 AND target_case_id=$3 AND operation_key=$6",
            [
              actor.tenantId,
              caseAId,
              caseBId,
              claim,
              mode + "_RUNNING",
              operationKey,
            ],
          );
          claimed = true;
          return row;
        },
      );
      if (operation.state === "COMPLETE")
        return {
          state: "COMPLETE" as const,
          result: operation.result,
          off: operation.off_result,
        };
      if (mode === "OFF" && operation.off_result)
        return {
          state: "OFF_DONE" as const,
          off: operation.off_result,
          result: null,
        };
      if (
        scoped.tenantConfig.namespace !== `morrow-testnet:${actor.tenantId}` ||
        scoped.tenantConfig.network !== "testnet"
      )
        throw new DomainError("FAIR_UNAVAILABLE", 503);
      const before: Awaited<ReturnType<FairComparisonService["snapshot"]>> =
        operation.frozen?.before ??
        (await this.snapshot(actor, caseAId, caseBId));
      // One fresh payment observation is frozen and shared by both arms.
      // A second observation at completion is only a drift/safety check.
      const check =
        operation.frozen?.check ??
        (await this.resolution.investigate(actor, caseBId));
      const observed =
        operation.frozen?.observed ??
        (await tenantTransaction(this.pool, actor.tenantId, async (db) => {
          await authorize(db, actor);
          return (
            await db.query(
              "SELECT id,verdict,reason,evidence FROM morrow.payment_checks WHERE tenant_id=$1 AND id=$2",
              [actor.tenantId, check.id],
            )
          ).rows[0];
        }));
      const snapshot = {
        ...before,
        observation: observed,
        snapshotHash: createHash("sha256")
          .update(JSON.stringify({ state: before, observation: observed }))
          .digest("hex"),
      };
      const target = before.cases.find((r) => r.id === caseBId)!;
      const evidence = [
        {
          id: check.id,
          kind: "payment_check",
          facts: {
            verdict: check.verdict,
            reason: check.reason,
            entitled: target.entitled,
          },
        },
      ];
      const context = {
        caseId: caseBId,
        policyVersion: before.policyVersion,
        evidence,
      };
      // Persist exact evidence before inference so a retry cannot silently change inputs.
      if (!operation.frozen)
        await tenantTransaction(this.pool, actor.tenantId, (db) =>
          db.query(
            "UPDATE morrow.comparison_baselines SET frozen=$4::jsonb WHERE tenant_id=$1 AND source_case_id=$2 AND target_case_id=$3 AND claim=$5",
            [
              actor.tenantId,
              caseAId,
              caseBId,
              JSON.stringify({ before, check, observed }),
              claim,
            ],
          ),
        );
      const planner = this.agent.planner;
      const propose = (
        lessons: Array<{ blobId: string; procedure: string[] }>,
      ): Promise<import("./agent.js").Recommendation> =>
        before.grantEnabled
          ? planner.investigate({ ...context, lessons })
          : Promise.resolve({
              action: "REFUSE" as const,
              reason: "Current policy does not permit a repair.",
              evidenceIds: [check.id],
              uncertainty: "low",
            });
      const offProposal = operation.off_result?.proposal ?? (await propose([]));
      const offPlan: string[] = [...BASE_STEPS];
      const off = {
        caseId: caseBId,
        mode: "OFF",
        plan: offPlan,
        proposal: offProposal,
        investigation: check,
        metrics: {
          steps: offPlan.length,
          lessonsConsidered: 0,
          guidance: "No lesson guidance used.",
        },
        recall: { status: "SKIPPED_OFF", blobIds: [], count: 0 },
      };
      if (mode === "OFF") {
        await tenantTransaction(this.pool, actor.tenantId, async (db) => {
          await authorize(db, actor);
          const saved = await db.query(
            "UPDATE morrow.comparison_baselines SET state='OFF_DONE',off_result=$4::jsonb,lease_until=NULL WHERE tenant_id=$1 AND source_case_id=$2 AND target_case_id=$3 AND claim=$5 RETURNING id",
            [actor.tenantId, caseAId, caseBId, JSON.stringify(off), claim],
          );
          if (!saved.rowCount) throw new DomainError("COMPARISON_BUSY", 409);
        });
        return { state: "OFF_DONE" as const, off, result: null };
      }
      const query = `PAID_ACCESS_MISSING source:${caseAId} target:${caseBId}`;
      const recalledAt = new Date().toISOString();
      let status = "OK";
      let hits: Array<{ blobId: string; text: string }> = [];
      try {
        hits = await scoped.gateway.recall(query);
      } catch {
        status = "UNAVAILABLE";
      }
      const eligible = await tenantTransaction(
        this.pool,
        actor.tenantId,
        async (db) => {
          const current = await authorize(db, actor);
          if (current.policy_version !== before.policyVersion) return [];
          const rows = await db.query(
            `SELECT id,payload,blob_id,content_hash,network,account_id,namespace FROM morrow.lessons
          WHERE tenant_id=$1 AND case_id=$2 AND state='RECALL_VERIFIED' AND policy_version=$3 AND blob_id IS NOT NULL ORDER BY recalled_at DESC LIMIT 5`,
            [actor.tenantId, caseAId, before.policyVersion],
          );
          return rows.rows.flatMap((row) => {
            if (
              row.network !== scoped.tenantConfig.network ||
              row.account_id !== scoped.tenantConfig.accountId ||
              row.namespace !== scoped.tenantConfig.namespace
            )
              return [];
            const hit = hits.find(
              (h) =>
                h.blobId === row.blob_id &&
                createHash("sha256").update(h.text).digest("hex") ===
                  row.content_hash,
            );
            if (!hit) return [];
            let parsed;
            try {
              parsed = lessonSchema.safeParse(JSON.parse(hit.text));
            } catch {
              return [];
            }
            if (
              !parsed.success ||
              parsed.data.sourceCaseId !== caseAId ||
              parsed.data.policyVersion !== before.policyVersion
            )
              return [];
            if (
              !target.product_category ||
              !(
                parsed.data.applicableCategories ?? [
                  parsed.data.productCategory,
                ]
              ).includes(target.product_category)
            )
              return [];
            if (
              JSON.stringify(parsed.data) !==
              JSON.stringify(lessonSchema.parse(row.payload))
            )
              return [];
            return [
              {
                blobId: row.blob_id as string,
                sourceCaseId: parsed.data.sourceCaseId,
                appliesTo: target.product_category,
                policyVersion: parsed.data.policyVersion,
                procedure: parsed.data.procedure,
              },
            ];
          });
        },
      );
      if (status === "OK" && eligible.length === 0)
        status = "NO_ELIGIBLE_LESSON";
      const onProposal = await propose(eligible);
      const recheck = await this.resolution.investigate(actor, caseBId);
      const after = await this.snapshot(actor, caseAId, caseBId);
      const drift =
        before.snapshotHash !== after.snapshotHash ||
        check.verdict !== recheck.verdict ||
        check.reason !== recheck.reason;
      const conclusive =
        !drift &&
        check.verdict !== "UNKNOWN" &&
        status === "OK" &&
        offProposal.execution?.model === onProposal.execution?.model;
      const semantic = (proposal: import("./agent.js").Recommendation) => ({
        action: proposal.action,
        reason: proposal.reason,
        evidenceIds: proposal.evidenceIds,
        uncertainty: proposal.uncertainty,
      });
      const onPlan: string[] = [...BASE_STEPS];
      for (const l of eligible)
        for (const step of l.procedure)
          if (!onPlan.includes(step)) onPlan.push(step);
      const on = {
        caseId: caseBId,
        mode: "ON",
        plan: onPlan,
        proposal: onProposal,
        investigation: check,
        metrics: {
          steps: onPlan.length,
          lessonsConsidered: eligible.length,
          guidance: `${eligible.length} verified lesson(s) used.`,
        },
        recall: {
          status,
          blobIds: eligible.map((l) => l.blobId),
          count: eligible.length,
          query,
          recalledAt,
          provenance: eligible.map(
            ({ blobId, sourceCaseId, appliesTo, policyVersion }) => ({
              blobId,
              sourceCaseId,
              appliesTo,
              policyVersion,
            }),
          ),
          namespace: scoped.tenantConfig.namespace,
          network: scoped.tenantConfig.network,
          accountId: scoped.tenantConfig.accountId,
        },
      };
      const comparison = {
        sourceCaseId: caseAId,
        targetCaseId: caseBId,
        policyVersion: before.policyVersion,
        targetVersion: target.version,
        snapshotHash: snapshot.snapshotHash,
        drift,
        offSteps: offPlan.length,
        onSteps: onPlan.length,
        stepsDelta: onPlan.length - offPlan.length,
        offLessons: 0,
        onLessons: eligible.length,
        outcome: !conclusive
          ? "INCONCLUSIVE"
          : JSON.stringify(semantic(offProposal)) !==
              JSON.stringify(semantic(onProposal))
            ? "GUIDANCE_DIFFERENCE"
            : "EQUAL",
        readOnly: true,
        simulation: false,
        planner: this.agent.name,
        measurement: "read-only proposals; no causal benefit claim",
      };
      const result = {
        sourceCaseId: caseAId,
        targetCaseId: caseBId,
        snapshot,
        off,
        on,
        caseA: off,
        caseB: on,
        comparison,
      };
      await tenantTransaction(this.pool, actor.tenantId, async (db) => {
        await authorize(db, actor);
        const saved = await db.query(
          "UPDATE morrow.comparison_baselines SET state='COMPLETE',result=$4::jsonb,lease_until=NULL WHERE tenant_id=$1 AND source_case_id=$2 AND target_case_id=$3 AND claim=$5 RETURNING id",
          [actor.tenantId, caseAId, caseBId, JSON.stringify(result), claim],
        );
        if (!saved.rowCount) throw new DomainError("COMPARISON_BUSY", 409);
        await db.query(
          `INSERT INTO morrow.case_events(tenant_id,case_id,operator_id,kind,data) VALUES($1,$2,$3,'COMPARISON_RUN',$4::jsonb)`,
          [
            actor.tenantId,
            caseBId,
            actor.operatorId,
            JSON.stringify({
              comparison,
              off,
              on,
              snapshot,
              recheck,
              readOnly: true,
            }),
          ],
        );
      });
      return { state: "COMPLETE" as const, result, off };
    } catch (error) {
      if (claimed)
        await tenantTransaction(this.pool, actor.tenantId, (db) =>
          db.query(
            "UPDATE morrow.comparison_baselines SET state=CASE WHEN off_result IS NULL THEN 'OFF_FAILED' ELSE 'ON_FAILED' END,lease_until=NULL,error_code='COMPARISON_UNAVAILABLE' WHERE tenant_id=$1 AND source_case_id=$2 AND target_case_id=$3 AND claim=$4",
            [actor.tenantId, caseAId, caseBId, claim],
          ),
        );
      throw error;
    } finally {
      scoped.close();
    }
  }

  private async eligibleLessons(
    db: import("pg").PoolClient,
    actor: Actor,
    policyVersion: number,
  ) {
    const rows = await db.query(
      `SELECT id, payload, blob_id FROM morrow.lessons
       WHERE tenant_id=$1 AND state='RECALL_VERIFIED' AND policy_version=$2 AND blob_id IS NOT NULL
       ORDER BY recalled_at DESC LIMIT 5`,
      [actor.tenantId, policyVersion],
    );
    return rows.rows.map((r) => {
      const payload = (
        typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload
      ) as { procedure?: Array<string> };
      return {
        id: r.id,
        blobId: r.blob_id,
        procedure: Array.isArray(payload?.procedure) ? payload.procedure : [],
      };
    });
  }
}
