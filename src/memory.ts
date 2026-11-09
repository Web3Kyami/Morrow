import { z } from "zod";
import { createHash } from "node:crypto";

const jobSchema = z.object({
  job_id: z.string().min(1),
  status: z.enum([
    "pending",
    "running",
    "uploaded",
    "done",
    "failed",
    "not_found",
  ]),
  blob_id: z.string().min(1).optional(),
});
export function classifyMemoryJob(input: unknown) {
  const parsed = jobSchema.safeParse(input);
  if (!parsed.success) return { state: "UNKNOWN" as const };
  const job = parsed.data;
  if (job.status === "failed")
    return { state: "FAILED" as const, jobId: job.job_id };
  if (job.status === "not_found")
    return { state: "UNKNOWN" as const, jobId: job.job_id };
  if (job.status !== "done")
    return { state: "PENDING" as const, jobId: job.job_id };
  if (!job.blob_id) return { state: "UNKNOWN" as const, jobId: job.job_id };
  return {
    state: "COMPLETED" as const,
    jobId: job.job_id,
    blobId: job.blob_id,
  };
}
// Closed vocabulary: no customer transcript, address, credential or arbitrary text enters the relayer.
export const lessonSchema = z
  .object({
    sourceCaseId: z.uuid(),
    policyVersion: z.number().int().positive(),
    productCategory: z.enum([
      "course",
      "download",
      "subscription",
      "pass",
      "service",
    ]),
    applicableCategories: z
      .array(z.enum(["course", "download", "subscription", "pass", "service"]))
      .min(1)
      .max(5)
      .optional(),
    problem: z.literal("PAID_ACCESS_MISSING"),
    procedure: z
      .array(
        z.enum([
          "VERIFY_CURRENT_ORDER",
          "VERIFY_PAYMENT_INTENT",
          "CHECK_CURRENT_POLICY",
          "CHECK_PERSISTED_ACCESS",
          "REQUEST_MERCHANT_APPROVAL",
          "GRANT_IDEMPOTENTLY",
          "CONFIRM_READBACK",
          "ESCALATE_UNKNOWN",
        ]),
      )
      .min(5)
      .max(8)
      .refine(
        (items) => new Set(items).size === items.length,
        "Duplicate steps",
      )
      .refine(
        (items) =>
          [
            "VERIFY_PAYMENT_INTENT",
            "REQUEST_MERCHANT_APPROVAL",
            "GRANT_IDEMPOTENTLY",
            "CONFIRM_READBACK",
          ].every((step) => items.includes(step as (typeof items)[number])),
        "Required safety steps missing",
      ),
    outcome: z.literal("READBACK_CONFIRMED"),
    fictional: z.literal(true),
  })
  .strict();
export type Lesson = z.infer<typeof lessonSchema>;
export function describeLesson(input: Lesson) {
  const lesson = lessonSchema.parse(input);
  const { sourceCaseId: _, ...operational } = lesson;
  const text = JSON.stringify(lesson);
  return {
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(operational))
      .digest("hex"),
  };
}
export interface MemoryGateway {
  remember(text: string, idempotencyKey: string): Promise<{ jobId: string }>;
  status(jobId: string): Promise<unknown>;
  recall(query: string): Promise<Array<{ blobId: string; text: string }>>;
  close(): void;
}
export type MainnetProof = {
  network: string;
  fingerprint: string;
  blobId: string;
  jobId: string;
  freshRecall: boolean;
  approved: boolean;
  completedAt: string;
};
export function verifyMainnetRegister(rows: MainnetProof[]) {
  const valid = rows.filter(
    (r) =>
      r.network === "mainnet" &&
      r.approved &&
      r.freshRecall &&
      r.fingerprint &&
      r.blobId &&
      r.jobId &&
      Number.isFinite(Date.parse(r.completedAt)),
  );
  const fingerprints = new Set<string>(),
    blobs = new Set<string>(),
    jobs = new Set<string>();
  for (const row of valid) {
    if (
      fingerprints.has(row.fingerprint) ||
      blobs.has(row.blobId) ||
      jobs.has(row.jobId)
    )
      continue;
    fingerprints.add(row.fingerprint);
    blobs.add(row.blobId);
    jobs.add(row.jobId);
  }
  const distinct = fingerprints.size;
  return {
    status: distinct >= 10 ? ("PASS" as const) : ("BLOCKED" as const),
    distinctConfirmedMainnetMemories: distinct,
  };
}
