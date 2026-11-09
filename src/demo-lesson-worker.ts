import { tenantTransaction, type Database } from "./database.js";
import { authorizeOperator } from "./authorization.js";
import { LessonService } from "./lessons.js";
import type { ScopedMemory } from "./lesson-factory.js";
export class DemoLessonWorker {
  constructor(
    private readonly pool: Database,
    private readonly memoryFor: (tenantId: string) => ScopedMemory | null,
  ) {}
  async runOne(lessonId?: string) {
    const job = (
      await this.pool.query("SELECT * FROM morrow.claim_demo_lesson_job($1)", [
        lessonId ?? null,
      ])
    ).rows[0];
    if (!job) return null;
    const update = (state: string, error: string | null = null) =>
      tenantTransaction(this.pool, job.tenant_id, (db) =>
        db.query(
          "UPDATE morrow.demo_lesson_jobs SET state=$3,error_code=$4,lease_until=NULL,not_before=clock_timestamp()+interval '20 seconds' WHERE tenant_id=$1 AND lesson_id=$2",
          [job.tenant_id, job.lesson_id, state, error],
        ),
      );
    let scope: ScopedMemory | null = null;
    try {
      scope = this.memoryFor(job.tenant_id);
      if (!scope) throw Error("MEMORY_UNAVAILABLE");
      if (job.lesson_state === "APPROVED")
        await tenantTransaction(this.pool, job.tenant_id, async (db) => {
          const policy = await authorizeOperator(db, {
            tenantId: job.tenant_id,
            operatorId: job.operator_id,
            role: "judge",
          });
          if (policy.policy_version !== job.policy_version)
            throw Error("STALE_POLICY");
        });
      const service = new LessonService(
        this.pool,
        scope.tenantConfig,
        scope.gateway,
      );
      const current = await service.advance(job.tenant_id, job.lesson_id);
      if (current.state === "FAILED") {
        await update("FAILED", "MEMORY_FAILED");
        return "FAILED";
      }
      if (
        current.state === "COMPLETED" ||
        current.state === "RECALL_VERIFIED"
      ) {
        const fresh = this.memoryFor(job.tenant_id);
        if (!fresh) throw Error("MEMORY_UNAVAILABLE");
        try {
          await service.verifyRecall(
            job.tenant_id,
            job.lesson_id,
            fresh.gateway,
          );
        } finally {
          fresh.close();
        }
        await update("DONE");
        return "RECALL_VERIFIED";
      }
      await update("QUEUED");
      return current.state;
    } catch (error) {
      const stale = error instanceof Error && error.message === "STALE_POLICY";
      await update(
        stale ? "FAILED" : "QUEUED",
        stale ? "STALE_POLICY" : "MEMORY_PROVIDER_UNAVAILABLE",
      );
      return stale ? "FAILED" : "UNKNOWN";
    } finally {
      scope?.close();
    }
  }
}
