import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authorizeOperator, type Actor } from "./authorization.js";
import { tenantTransaction, type Database } from "./database.js";
import { DomainError } from "./errors.js";
import { lessonSchema, describeLesson } from "./memory.js";
import { MerchantService } from "./merchant.js";
import type { LessonService } from "./lessons.js";

const category = z.enum([
  "course",
  "download",
  "subscription",
  "pass",
  "service",
]);
const procedure = lessonSchema.shape.procedure;
const procedureItems = [
  "VERIFY_CURRENT_ORDER",
  "VERIFY_PAYMENT_INTENT",
  "CHECK_CURRENT_POLICY",
  "CHECK_PERSISTED_ACCESS",
  "REQUEST_MERCHANT_APPROVAL",
  "GRANT_IDEMPOTENTLY",
  "CONFIRM_READBACK",
  "ESCALATE_UNKNOWN",
] as const;
const DEFAULT_PROCEDURE: z.infer<typeof procedure> = [
  "VERIFY_CURRENT_ORDER",
  "VERIFY_PAYMENT_INTENT",
  "CHECK_CURRENT_POLICY",
  "CHECK_PERSISTED_ACCESS",
  "REQUEST_MERCHANT_APPROVAL",
  "GRANT_IDEMPOTENTLY",
  "CONFIRM_READBACK",
  "ESCALATE_UNKNOWN",
];

const editSchema = z
  .object({
    version: z.number().int().positive(),
    productCategory: category,
    applicableCategories: z.array(category).min(1).max(5),
    procedure,
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.applicableCategories.includes(input.productCategory))
      context.addIssue({
        code: "custom",
        path: ["applicableCategories"],
        message: "Include the source product category",
      });
  });

type DraftRow = {
  version: number;
  payload: unknown;
  approval_state: "DRAFT" | "APPROVING" | "APPROVED";
  approved_lesson_id: string | null;
};

/** Tenant-scoped merchant lesson editing, approval and library projection. */
export class MerchantLessonService {
  constructor(private readonly pool: Database) {}

  private async eligible(actor: Actor, caseId: string) {
    const detail = await new MerchantService(this.pool).detail(actor, caseId);
    if (!detail.summary.allowed.createLesson || !detail.repairs.length)
      throw new DomainError("REPAIR_NOT_CONFIRMED", 409);
    return detail;
  }

  async getDraft(actor: Actor, caseId: string) {
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      await authorizeOperator(db, actor);
      return (
        (
          await db.query(
            `SELECT version,payload,approval_state,approved_lesson_id
           FROM morrow.merchant_lesson_drafts WHERE tenant_id=$1 AND case_id=$2`,
            [actor.tenantId, caseId],
          )
        ).rows[0] ?? null
      );
    });
  }

  private draftPayload(
    caseId: string,
    policyVersion: number,
    productCategory: z.infer<typeof category>,
    applicableCategories: z.infer<typeof category>[],
    steps: z.infer<typeof procedure>,
  ) {
    return lessonSchema.parse({
      sourceCaseId: caseId,
      policyVersion,
      productCategory,
      applicableCategories,
      problem: "PAID_ACCESS_MISSING",
      procedure: steps,
      outcome: "READBACK_CONFIRMED",
      fictional: true,
    });
  }

  async openDraft(
    actor: Actor,
    caseId: string,
    productCategory: z.infer<typeof category>,
  ) {
    const detail = await this.eligible(actor, caseId);
    const payload = this.draftPayload(
      caseId,
      detail.policy.policyVersion,
      productCategory,
      [productCategory],
      DEFAULT_PROCEDURE,
    );
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorizeOperator(db, actor);
      if (policy.policy_version !== detail.policy.policyVersion)
        throw new DomainError("STALE_POLICY", 409);
      await db.query(
        `INSERT INTO morrow.merchant_lesson_drafts(tenant_id,case_id,payload,updated_by)
         VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
        [actor.tenantId, caseId, JSON.stringify(payload), actor.operatorId],
      );
      return (
        await db.query(
          `SELECT version,payload,approval_state,approved_lesson_id
           FROM morrow.merchant_lesson_drafts WHERE tenant_id=$1 AND case_id=$2`,
          [actor.tenantId, caseId],
        )
      ).rows[0] as DraftRow;
    });
  }

  async saveDraft(actor: Actor, caseId: string, input: unknown) {
    const body = editSchema.parse(input);
    const detail = await this.eligible(actor, caseId);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorizeOperator(db, actor);
      if (policy.policy_version !== detail.policy.policyVersion)
        throw new DomainError("STALE_POLICY", 409);
      const saved = await db.query(
        `UPDATE morrow.merchant_lesson_drafts
         SET payload=$5::jsonb,version=version+1,updated_by=$4,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND case_id=$2 AND version=$3
           AND approval_state='DRAFT' AND approved_lesson_id IS NULL
         RETURNING version,payload,approval_state`,
        [
          actor.tenantId,
          caseId,
          body.version,
          actor.operatorId,
          JSON.stringify(
            this.draftPayload(
              caseId,
              policy.policy_version,
              body.productCategory,
              body.applicableCategories,
              body.procedure,
            ),
          ),
        ],
      );
      if (!saved.rowCount) throw new DomainError("STALE_DRAFT", 409);
      return saved.rows[0] as DraftRow;
    });
  }

  async approveDraft(
    actor: Actor,
    caseId: string,
    version: number,
    lessons: LessonService | null,
  ) {
    if (!lessons) throw new DomainError("MEMORY_UNAVAILABLE", 503);
    const detail = await this.eligible(actor, caseId);
    const claim = randomUUID();
    const row = await tenantTransaction(
      this.pool,
      actor.tenantId,
      async (db) => {
        const policy = await authorizeOperator(db, actor);
        if (policy.policy_version !== detail.policy.policyVersion)
          throw new DomainError("STALE_POLICY", 409);
        const draft = (
          await db.query(
            `SELECT * FROM morrow.merchant_lesson_drafts
           WHERE tenant_id=$1 AND case_id=$2 FOR UPDATE`,
            [actor.tenantId, caseId],
          )
        ).rows[0] as
          (DraftRow & { approval_lease_until: Date | null }) | undefined;
        if (!draft || draft.version !== version)
          throw new DomainError("STALE_DRAFT", 409);
        if (draft.approved_lesson_id) return draft;
        if (
          draft.approval_state === "APPROVING" &&
          draft.approval_lease_until &&
          draft.approval_lease_until > new Date()
        )
          throw new DomainError("LESSON_BUSY", 409);
        await db.query(
          `UPDATE morrow.merchant_lesson_drafts
         SET approval_state='APPROVING',approval_claim=$3,
             approval_lease_until=clock_timestamp()+interval '90 seconds'
         WHERE tenant_id=$1 AND case_id=$2`,
          [actor.tenantId, caseId, claim],
        );
        return draft;
      },
    );
    if (row.approved_lesson_id)
      return { id: row.approved_lesson_id, state: "APPROVED" as const };
    try {
      const payload = lessonSchema.parse(row.payload);
      let id: string;
      try {
        id = (await lessons.approve(actor, payload)).id;
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
                `SELECT id FROM morrow.lessons WHERE tenant_id=$1 AND case_id=$2 AND content_hash=$3`,
                [actor.tenantId, caseId, describeLesson(payload).contentHash],
              )
            ).rows[0]?.id,
        );
        if (!id) throw error;
      }
      await tenantTransaction(this.pool, actor.tenantId, async (db) => {
        await authorizeOperator(db, actor);
        const updated = await db.query(
          `UPDATE morrow.merchant_lesson_drafts
           SET approval_state='APPROVED',approved_lesson_id=$4,approval_lease_until=NULL
           WHERE tenant_id=$1 AND case_id=$2 AND approval_claim=$3`,
          [actor.tenantId, caseId, claim, id],
        );
        if (!updated.rowCount) throw new DomainError("LESSON_BUSY", 409);
      });
      return { id, state: "APPROVED" as const };
    } catch (error) {
      await tenantTransaction(this.pool, actor.tenantId, (db) =>
        db.query(
          `UPDATE morrow.merchant_lesson_drafts SET approval_state='DRAFT',approval_claim=NULL,approval_lease_until=NULL
           WHERE tenant_id=$1 AND case_id=$2 AND approval_claim=$3 AND approved_lesson_id IS NULL`,
          [actor.tenantId, caseId, claim],
        ),
      );
      throw error;
    }
  }

  async library(actor: Actor, query = "") {
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      await authorizeOperator(db, actor);
      const lessons = await db.query(
        `SELECT id,case_id,policy_version,network,namespace,state,job_id,blob_id,
                completed_at,recalled_at,created_at,payload
         FROM morrow.lessons WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [actor.tenantId],
      );
      const drafts = await db.query(
        `SELECT case_id,version,payload,approval_state,updated_at
         FROM morrow.merchant_lesson_drafts
         WHERE tenant_id=$1 AND approval_state<>'APPROVED' ORDER BY updated_at DESC LIMIT 100`,
        [actor.tenantId],
      );
      const search = query.trim().toLowerCase();
      const parsedLessons = lessons.rows.flatMap((row) => {
        const parsed = lessonSchema.safeParse(row.payload);
        if (!parsed.success) return [];
        const lesson = parsed.data;
        const item = {
          id: row.id as string,
          caseId: row.case_id as string,
          policyVersion: row.policy_version as number,
          network: row.network as string,
          state: row.state as string,
          jobId: row.job_id as string | null,
          blobId: row.blob_id as string | null,
          completedAt: row.completed_at as Date | null,
          recalledAt: row.recalled_at as Date | null,
          productCategory: lesson.productCategory,
          applicableCategories: lesson.applicableCategories ?? [
            lesson.productCategory,
          ],
          procedure: lesson.procedure,
          problem: lesson.problem,
        };
        return !search ||
          [item.caseId, item.productCategory, item.state, item.problem]
            .join(" ")
            .toLowerCase()
            .includes(search)
          ? [item]
          : [];
      });
      const parsedDrafts = drafts.rows.flatMap((row) => {
        const parsed = lessonSchema.safeParse(row.payload);
        if (!parsed.success) return [];
        const item = {
          caseId: row.case_id as string,
          version: row.version as number,
          approvalState: row.approval_state as string,
          productCategory: parsed.data.productCategory,
          policyVersion: parsed.data.policyVersion,
          applicableCategories: parsed.data.applicableCategories,
          updatedAt: row.updated_at as Date,
        };
        return !search ||
          [item.caseId, item.productCategory, "draft"]
            .join(" ")
            .toLowerCase()
            .includes(search)
          ? [item]
          : [];
      });
      return { lessons: parsedLessons, drafts: parsedDrafts };
    });
  }
}

export const merchantLessonCategory = category;
export const merchantLessonProcedure = procedure;
export const merchantLessonProcedureItems = procedureItems;
export const merchantLessonEditSchema = editSchema;
