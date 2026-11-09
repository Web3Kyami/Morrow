import { createHash, randomUUID } from "node:crypto";
import { tenantTransaction, type Database } from "./database.js";
import { DomainError } from "./errors.js";
import {
  lessonSchema,
  classifyMemoryJob,
  describeLesson,
  type Lesson,
  type MemoryGateway,
} from "./memory.js";
import { actorSchema, authorizeOperator, type Actor } from "./authorization.js";
import type { MemoryConfig } from "./config.js";

/** Internal worker seam only; no public endpoint can approve lessons or spend provider quota. */
export class LessonService {
  constructor(
    private readonly pool: Database,
    private readonly config: MemoryConfig,
    private readonly gateway: MemoryGateway,
  ) {}
  async approve(actor: Actor, input: Lesson) {
    actorSchema.parse(actor);
    const lesson = lessonSchema.parse(input);
    const { text, fingerprint, contentHash } = describeLesson(lesson);
    if (!this.config.namespace.endsWith(`:${actor.tenantId}`))
      throw new DomainError("MEMORY_SCOPE_MISMATCH", 403);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const a = await authorizeOperator(db, actor);
      if (a.policy_version !== lesson.policyVersion)
        throw new DomainError("STALE_POLICY");
      const source = await db.query(
        `SELECT 1 FROM morrow.cases c JOIN morrow.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id
        JOIN morrow.entitlements e ON e.tenant_id=o.tenant_id AND e.order_id=o.id AND e.product_id=o.product_id
        JOIN morrow.repairs r ON r.tenant_id=c.tenant_id AND r.case_id=c.id
        WHERE c.tenant_id=$1 AND c.id=$2`,
        [actor.tenantId, lesson.sourceCaseId],
      );
      if (!source.rowCount) throw new DomainError("REPAIR_NOT_CONFIRMED");
      const id = randomUUID();
      const row = await db.query(
        `INSERT INTO morrow.lessons(tenant_id,id,case_id,approved_by,policy_version,payload,fingerprint,network,account_id,namespace,content_hash,fingerprint_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,2) ON CONFLICT(network,account_id,namespace,fingerprint) DO NOTHING RETURNING id`,
        [
          actor.tenantId,
          id,
          lesson.sourceCaseId,
          actor.operatorId,
          lesson.policyVersion,
          text,
          fingerprint,
          this.config.network,
          this.config.accountId,
          this.config.namespace,
          contentHash,
        ],
      );
      if (!row.rowCount) throw new DomainError("LESSON_ALREADY_APPROVED");
      return { id, state: "APPROVED" as const };
    });
  }
  private async load(tenantId: string, id: string) {
    return tenantTransaction(this.pool, tenantId, async (db) => {
      const r = await db.query(
        "SELECT * FROM morrow.lessons WHERE tenant_id=$1 AND id=$2",
        [tenantId, id],
      );
      const row = r.rows[0];
      if (!row) throw new DomainError("NOT_FOUND", 404);
      if (
        row.namespace !== this.config.namespace ||
        row.network !== this.config.network ||
        row.account_id !== this.config.accountId
      )
        throw new DomainError("MEMORY_SCOPE_MISMATCH", 403);
      return row;
    });
  }
  async advance(tenantId: string, id: string) {
    const row = await this.load(tenantId, id);
    if (["COMPLETED", "RECALL_VERIFIED", "FAILED"].includes(row.state))
      return { state: row.state as string };
    let jobId = row.job_id as string | null;
    if (!jobId) {
      // Stable key reconciles a crash after provider acceptance but before local recording.
      const accepted = await this.gateway.remember(
        JSON.stringify(lessonSchema.parse(row.payload)),
        row.submission_attempt
          ? `${row.fingerprint}:retry:${row.submission_attempt}`
          : row.fingerprint,
      );
      jobId = accepted.jobId;
      await tenantTransaction(this.pool, tenantId, (db) =>
        db.query(
          "UPDATE morrow.lessons SET state='ACCEPTED',job_id=$3 WHERE tenant_id=$1 AND id=$2 AND job_id IS NULL",
          [tenantId, id, jobId],
        ),
      );
    }
    const raw = await this.gateway.status(jobId);
    const status = classifyMemoryJob(raw);
    if (status.jobId && status.jobId !== jobId)
      throw new DomainError("MEMORY_JOB_MISMATCH");
    const blobId = status.state === "COMPLETED" ? status.blobId : null;
    await tenantTransaction(this.pool, tenantId, (db) =>
      db.query(
        `UPDATE morrow.lessons SET state=$3,blob_id=$4,
      completed_at=CASE WHEN $3='COMPLETED' THEN clock_timestamp() ELSE completed_at END
      WHERE tenant_id=$1 AND id=$2 AND state NOT IN ('COMPLETED','RECALL_VERIFIED','FAILED')`,
        [tenantId, id, status.state, blobId],
      ),
    );
    return status;
  }
  async verifyRecall(
    tenantId: string,
    id: string,
    freshGateway: MemoryGateway,
  ) {
    const row = await this.load(tenantId, id);
    if (!["COMPLETED", "RECALL_VERIFIED"].includes(row.state) || !row.blob_id)
      throw new DomainError("MEMORY_NOT_COMPLETED");
    const hits = await freshGateway.recall(JSON.stringify(row.payload));
    const match = hits.find(
      (h) =>
        h.blobId === row.blob_id &&
        createHash("sha256").update(h.text).digest("hex") === row.content_hash,
    );
    if (!match) throw new DomainError("FRESH_RECALL_NOT_CONFIRMED");
    await tenantTransaction(this.pool, tenantId, (db) =>
      db.query(
        "UPDATE morrow.lessons SET state='RECALL_VERIFIED',recalled_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [tenantId, id],
      ),
    );
    return { state: "RECALL_VERIFIED" as const, blobId: row.blob_id as string };
  }
}
