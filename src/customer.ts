import { projectCase } from "./case-state.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { tenantTransaction, type Database } from "./database.js";
import { DomainError } from "./errors.js";

/**
 * Customer intake matches fictional demo receipt references and emails.
 * Database lookups exclude ordinary merchant tenants: real customer access
 * requires a separate verified ownership flow. Only receipt hashes are stored.
 * Status returns persisted verdicts, never raw digests or identity lookups.
 */
export const intakeSchema = z
  .object({
    orderRef: z
      .string()
      .trim()
      .toUpperCase()
      .regex(
        /^MRW-[A-Z0-9]{4,16}$/,
        "Enter the order reference from your receipt.",
      ),
    email: z.email({ error: "Enter a valid email address." }),
    issue: z
      .string()
      .trim()
      .min(5, "Tell us what went wrong in a few words.")
      .max(500),
  })
  .strict();
export type IntakeInput = z.infer<typeof intakeSchema>;

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function hash(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export function mintAccessToken() {
  return randomBytes(32).toString("base64url");
}

const MAX_INTAKE_PER_REFERENCE_PER_DAY = 5;

export class CustomerService {
  constructor(private readonly pool: Database) {}

  async intake(input: IntakeInput) {
    const parsed = intakeSchema.parse(input);
    const referenceHash = hash(parsed.orderRef);
    const emailHash = hash(parsed.email);
    // Pre-auth lookup needs no tenant context; function checks both hashes.
    const found = await this.pool.query(
      "SELECT tenant_id, order_id, case_id FROM morrow.lookup_order_ref($1,$2)",
      [referenceHash, emailHash],
    );
    const row = found.rows[0];
    if (!row) throw new DomainError("ORDER_NOT_FOUND", 404);

    const token = mintAccessToken();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const created = await tenantTransaction(
      this.pool,
      row.tenant_id,
      async (db) => {
        // Serialize first creation and token rotation for this case across concurrent requests.
        await db.query(
          "SELECT id FROM morrow.cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [row.tenant_id, row.case_id],
        );
        // Durable counted attempts: each permitted demo-receipt-matched
        // submission appends one help_intake_attempts row inside this
        // serialized transaction, so repeats, concurrency and restarts
        // cannot bypass the rolling 24h, per-order limit (5/day).
        // Denied attempts are not recorded: the 429 rolls back, so a
        // denied retry does not extend the window. Wrong ownership
        // never reaches here (generic 404 above).
        const recent = await db.query(
          `SELECT count(*)::int AS n FROM morrow.help_intake_attempts
           WHERE tenant_id=$1 AND order_id=$2
           AND attempted_at > clock_timestamp() - interval '1 day'`,
          [row.tenant_id, row.order_id],
        );
        if (Number(recent.rows[0]?.n ?? 0) >= MAX_INTAKE_PER_REFERENCE_PER_DAY)
          throw new DomainError("INTAKE_RATE_LIMITED", 429);
        await db.query(
          `INSERT INTO morrow.help_intake_attempts(tenant_id,id,order_id,case_id)
           VALUES ($1,$2,$3,$4)`,
          [row.tenant_id, randomUUID(), row.order_id, row.case_id],
        );

        const existing = await db.query(
          "SELECT id FROM morrow.help_requests WHERE tenant_id=$1 AND case_id=$2",
          [row.tenant_id, row.case_id],
        );
        if (existing.rows[0]) {
          await db.query(
            `UPDATE morrow.help_requests
             SET issue=$3, access_token_hash=$4,
                 access_expires_at=clock_timestamp()+interval '72 hours'
             WHERE tenant_id=$1 AND id=$2`,
            [row.tenant_id, existing.rows[0].id, parsed.issue, tokenHash],
          );
          return { id: existing.rows[0].id as string, fresh: false };
        }
        const id = randomUUID();
        await db.query(
          `INSERT INTO morrow.help_requests(tenant_id,id,case_id,issue,access_token_hash,access_expires_at)
           VALUES ($1,$2,$3,$4,$5,clock_timestamp()+interval '72 hours')`,
          [row.tenant_id, id, row.case_id, parsed.issue, tokenHash],
        );
        return { id, fresh: true };
      },
    );
    return {
      caseId: row.case_id as string,
      helpRequestId: created.id,
      accessToken: token,
      created: created.fresh,
    };
  }

  async status(caseId: string, token: string) {
    z.uuid().parse(caseId);
    if (!tokenSchema.safeParse(token).success)
      throw new DomainError("INVALID_ACCESS_TOKEN", 403);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    // Resolve the tenant through the access check without exposing lookup.
    const found = await this.pool.query(
      "SELECT tenant_id FROM morrow.lookup_help_access($1,$2)",
      [caseId, tokenHash],
    );
    const row = found.rows[0];
    if (!row) throw new DomainError("CASE_NOT_FOUND", 404);
    const tenantId = row.tenant_id as string;

    return tenantTransaction(this.pool, tenantId, async (db) => {
      const help = await db.query(
        "SELECT id, issue, created_at FROM morrow.help_requests WHERE tenant_id=$1 AND case_id=$2",
        [tenantId, caseId],
      );
      if (!help.rows[0]) throw new DomainError("CASE_NOT_FOUND", 404);
      const order = await db.query(
        `SELECT o.id AS order_id, p.created_at AS intent_created_at, p.expires_at AS intent_expires_at
         FROM morrow.cases c
         JOIN morrow.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id
         LEFT JOIN morrow.payment_intents p ON p.tenant_id=o.tenant_id AND p.order_id=o.id
         WHERE c.tenant_id=$1 AND c.id=$2`,
        [tenantId, caseId],
      );
      const latestCheck = await db.query(
        `SELECT verdict, reason, checked_at FROM morrow.payment_checks
         WHERE tenant_id=$1 AND case_id=$2 ORDER BY checked_at DESC LIMIT 1`,
        [tenantId, caseId],
      );
      const access = await db.query(
        `SELECT granted_at FROM morrow.entitlements e
         JOIN morrow.cases c ON c.tenant_id=e.tenant_id AND c.order_id=e.order_id
         JOIN morrow.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id AND o.product_id=e.product_id
         WHERE e.tenant_id=$1 AND c.id=$2 LIMIT 1`,
        [tenantId, caseId],
      );
      const repair = await db.query(
        `SELECT id, created_at FROM morrow.repairs
         WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [tenantId, caseId],
      );
      const decisions = await db.query(
        `SELECT d.kind, d.created_at,
                (d.policy_version=t.policy_version AND d.case_version=c.version) AS current
         FROM morrow.decisions d
         JOIN morrow.cases c ON c.tenant_id=d.tenant_id AND c.id=d.case_id
         JOIN morrow.tenants t ON t.id=d.tenant_id
         WHERE d.tenant_id=$1 AND d.case_id=$2 ORDER BY d.case_version DESC LIMIT 1`,
        [tenantId, caseId],
      );
      const latest = latestCheck.rows[0];
      const policy = await db.query(
        "SELECT grant_enabled FROM morrow.tenants WHERE id=$1",
        [tenantId],
      );
      return {
        caseId,
        summary: projectCase(
          {
            payment: {
              verdict: latest?.verdict ?? "NOT_CHECKED",
              checkedAt: latest?.checked_at,
            },
            intentExpiresAt: order.rows[0]?.intent_expires_at,
            decision: decisions.rows[0] ?? null,
            policyEnabled: policy.rows[0]?.grant_enabled === true,
            entitled: access.rowCount === 1,
            executed: !!repair.rows[0],
          },
          "customer",
        ),
        helpRequest: {
          id: help.rows[0].id,
          issue: help.rows[0].issue,
          createdAt: help.rows[0].created_at,
        },
        order: order.rows[0]?.order_id
          ? {
              orderId: order.rows[0].order_id,
              paymentIntent: order.rows[0].intent_created_at
                ? {
                    createdAt: order.rows[0].intent_created_at,
                    expiresAt: order.rows[0].intent_expires_at,
                  }
                : null,
            }
          : null,
        // Reflects the latest persisted investigation only. NOT_CHECKED
        // means no server-side check has run yet, never a pass.
        payment: latest
          ? {
              verdict: latest.verdict,
              reason: latest.reason,
              checkedAt: latest.checked_at,
            }
          : { verdict: "NOT_CHECKED" as const },
        decision: decisions.rows[0]
          ? {
              kind: decisions.rows[0].kind,
              current: decisions.rows[0].current,
              createdAt: decisions.rows[0].created_at,
            }
          : null,
        access: {
          entitled: access.rowCount === 1,
          grantedAt: access.rows[0]?.granted_at ?? null,
        },
        repair: repair.rows[0]
          ? {
              id: repair.rows[0].id,
              createdAt: repair.rows[0].created_at,
            }
          : null,
      };
    });
  }
}
