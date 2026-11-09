import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { tenantTransaction, type Database } from "./database.js";
import { DomainError } from "./errors.js";
import {
  actorSchema,
  authorizeOperator as authorize,
  type Actor,
} from "./authorization.js";
import {
  DeterministicPlanner,
  OpenRouterPlanner,
  type AgentPlanner,
  type Recommendation,
} from "./agent.js";
import type { ResolutionService } from "./resolution.js";

/**
 * S6 investigation flow: run the existing Tatum-backed payment check,
 * then ask a read-only planner for a proposal. The recommendation is
 * persisted as a case event and returned; it cannot approve, grant or
 * write memory. Available planners: deterministic (always) and the
 * owner-keyed OpenRouter adapter (only when configured).
 */
export class InvestigationService {
  constructor(
    private readonly pool: Database,
    private readonly resolution: ResolutionService,
    private readonly planners: Map<string, AgentPlanner>,
    private readonly defaultPlanner: string,
  ) {}

  async recommend(actor: Actor, caseId: string, plannerName?: string) {
    actorSchema.parse(actor);
    z.uuid().parse(caseId);
    const name = plannerName ?? this.defaultPlanner;
    const planner = this.planners.get(name);
    if (!planner) throw new DomainError("AGENT_UNAVAILABLE", 503);

    const check = await this.resolution.investigate(actor, caseId);
    const snapshot = await tenantTransaction(
      this.pool,
      actor.tenantId,
      async (db) => {
        const policy = await authorize(db, actor);
        const row = (
          await db.query(
            "SELECT version FROM morrow.cases WHERE tenant_id=$1 AND id=$2",
            [actor.tenantId, caseId],
          )
        ).rows[0];
        if (!row) throw new DomainError("CASE_NOT_FOUND", 404);
        return {
          policy,
          version: row.version as number,
          evidence: await this.evidenceSummary(db, actor, caseId),
          lessons: [] as Array<{ blobId: string; procedure: string[] }>,
        };
      },
    );
    const factsHash = (evidence: typeof snapshot.evidence) =>
      createHash("sha256")
        .update(
          JSON.stringify({
            evidence: evidence.map((e) => ({ kind: e.kind, facts: e.facts })),
            lessons: snapshot.lessons,
          }),
        )
        .digest("hex");
    const evidenceHash = factsHash(snapshot.evidence),
      claimId = randomUUID();
    const bind = [
      actor.tenantId,
      caseId,
      snapshot.version,
      snapshot.policy.policy_version,
      name,
    ];
    if (snapshot.policy.grant_enabled) {
      const cached = await tenantTransaction(
        this.pool,
        actor.tenantId,
        async (db) => {
          await authorize(db, actor);
          const inserted = await db.query(
            `INSERT INTO morrow.investigation_runs(tenant_id,case_id,case_version,policy_version,planner,state,claim_id,evidence_hash,lease_until)
          VALUES($1,$2,$3,$4,$5,'RUNNING',$6,$7,clock_timestamp()+interval '90 seconds') ON CONFLICT DO NOTHING RETURNING claim_id`,
            [...bind, claimId, evidenceHash],
          );
          if (inserted.rowCount) return null;
          const row = (
            await db.query(
              `SELECT * FROM morrow.investigation_runs WHERE tenant_id=$1 AND case_id=$2 AND case_version=$3 AND policy_version=$4 AND planner=$5 FOR UPDATE`,
              bind,
            )
          ).rows[0];
          if (row.state === "SUCCEEDED" && row.evidence_hash === evidenceHash)
            return row.result;
          if (
            row.state === "RUNNING" &&
            new Date(row.lease_until).getTime() > Date.now()
          )
            throw new DomainError("AGENT_BUSY", 409);
          if (row.attempts >= 3)
            throw new DomainError("AGENT_RETRY_LIMIT", 429);
          await db.query(
            `UPDATE morrow.investigation_runs SET state='RUNNING',claim_id=$6,evidence_hash=$7,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1 WHERE tenant_id=$1 AND case_id=$2 AND case_version=$3 AND policy_version=$4 AND planner=$5`,
            [...bind, claimId, evidenceHash],
          );
          return null;
        },
      );
      if (cached) return cached;
    }
    try {
      // Model/provider waits occur outside database transactions/connections.
      const recommendation: Recommendation = snapshot.policy.grant_enabled
        ? await planner.investigate({
            caseId,
            policyVersion: snapshot.policy.policy_version,
            evidence: snapshot.evidence,
            lessons: snapshot.lessons,
          })
        : {
            action: "REFUSE",
            reason: "Current merchant policy does not permit an access repair.",
            evidenceIds: [],
            uncertainty: "low",
          };
      return await tenantTransaction(this.pool, actor.tenantId, async (db) => {
        const policy = await authorize(db, actor);
        const row = (
          await db.query(
            "SELECT version FROM morrow.cases WHERE tenant_id=$1 AND id=$2 FOR SHARE",
            [actor.tenantId, caseId],
          )
        ).rows[0];
        if (
          row?.version !== snapshot.version ||
          policy.policy_version !== snapshot.policy.policy_version ||
          policy.grant_enabled !== snapshot.policy.grant_enabled ||
          factsHash(await this.evidenceSummary(db, actor, caseId)) !==
            evidenceHash
        )
          throw new DomainError("STALE_INVESTIGATION", 409);
        const result = {
          planner: policy.grant_enabled ? name : "policy-guard",
          ...recommendation,
          caseVersion: snapshot.version,
          policyVersion: policy.policy_version,
          check: { verdict: check.verdict },
        };
        if (policy.grant_enabled) {
          const done = await db.query(
            `UPDATE morrow.investigation_runs SET state='SUCCEEDED',result=$7::jsonb WHERE tenant_id=$1 AND case_id=$2 AND case_version=$3 AND policy_version=$4 AND planner=$5 AND claim_id=$6 AND state='RUNNING' RETURNING claim_id`,
            [...bind, claimId, JSON.stringify(result)],
          );
          if (!done.rowCount) throw new DomainError("STALE_INVESTIGATION", 409);
        }
        await db.query(
          `INSERT INTO morrow.case_events(tenant_id,case_id,operator_id,kind,data) VALUES($1,$2,$3,'AGENT_RECOMMENDATION',$4::jsonb)`,
          [
            actor.tenantId,
            caseId,
            actor.operatorId,
            JSON.stringify({
              ...result,
              payment: { verdict: check.verdict, reason: check.reason },
              readOnly: true,
            }),
          ],
        );
        return result;
      });
    } catch (error) {
      if (snapshot.policy.grant_enabled)
        await tenantTransaction(this.pool, actor.tenantId, (db) =>
          db.query(
            `UPDATE morrow.investigation_runs SET state='FAILED' WHERE tenant_id=$1 AND case_id=$2 AND case_version=$3 AND policy_version=$4 AND planner=$5 AND claim_id=$6 AND state='RUNNING'`,
            [...bind, claimId],
          ),
        );
      throw error;
    }
  }

  private async evidenceSummary(
    db: import("pg").PoolClient,
    actor: Actor,
    caseId: string,
  ) {
    const latest = await db.query(
      `SELECT id, verdict, reason FROM morrow.payment_checks
       WHERE tenant_id=$1 AND case_id=$2 ORDER BY checked_at DESC LIMIT 1`,
      [actor.tenantId, caseId],
    );
    const access = await db.query(
      `SELECT 1 FROM morrow.entitlements e
       JOIN morrow.cases c ON c.tenant_id=e.tenant_id AND c.order_id=e.order_id
       WHERE e.tenant_id=$1 AND c.id=$2 LIMIT 1`,
      [actor.tenantId, caseId],
    );
    const facts: Array<{ id: string; kind: string; facts: unknown }> = [];
    if (latest.rows[0]) {
      facts.push({
        id: latest.rows[0].id,
        kind: "payment_check",
        facts: {
          verdict: latest.rows[0].verdict,
          reason: latest.rows[0].reason,
          entitled: access.rowCount === 1,
        },
      });
    }
    return facts;
  }
}

export function buildInvestigationService(
  pool: Database,
  resolution: ResolutionService,
  env: NodeJS.ProcessEnv = process.env,
) {
  const planners = new Map<string, AgentPlanner>();
  planners.set("deterministic-v1", new DeterministicPlanner());
  const key = env.OPENROUTER_API_KEY;
  const model = env.OPENROUTER_MODEL;
  if (key && model)
    planners.set("openrouter", new OpenRouterPlanner(key, model));
  const defaultPlanner = key && model ? "openrouter" : "deterministic-v1";
  return new InvestigationService(pool, resolution, planners, defaultPlanner);
}
