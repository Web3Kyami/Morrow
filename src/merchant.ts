import { projectCase } from "./case-state.js";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { verifyAccessToken } from "@privy-io/node";
import { z } from "zod";
import { tenantTransaction, type Database } from "./database.js";
import { DomainError } from "./errors.js";
import {
  actorSchema,
  authorizeOperator as authorize,
  type Actor,
} from "./authorization.js";
import { hash } from "./customer.js";

/**
 * Merchant sessions come from a verified Privy identity mapping or an
 * explicitly enabled local fixture credential. Every read is scoped to the
 * mapped tenant, and current authorization outranks any agent suggestion.
 * This module never approves or grants anything.
 */

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string) {
  try {
    const [scheme, saltHex, keyHex] = stored.split(":");
    if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
    const derived = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
    const expected = Buffer.from(keyHex, "hex");
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

const credentialsSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(200),
  })
  .strict();

function mintSessionToken() {
  return randomBytes(32).toString("base64url");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export class MerchantService {
  constructor(
    private readonly pool: Database,
    private readonly privy?: { appId: string; verificationKey: string },
    private readonly verifyPrivyToken: typeof verifyAccessToken = verifyAccessToken,
  ) {}

  get privyAppId() {
    return this.privy?.appId ?? null;
  }

  private async issueSession(tenantId: string, operatorId: string) {
    const token = mintSessionToken();
    await tenantTransaction(this.pool, tenantId, async (db) => {
      const actor = actorSchema.parse({
        tenantId,
        operatorId,
        role: "merchant",
      });
      await authorize(db, actor);
      await db.query(
        `INSERT INTO morrow.merchant_sessions(token_hash,tenant_id,operator_id,expires_at)
         VALUES ($1,$2,$3,clock_timestamp()+interval '8 hours')`,
        [tokenHash(token), tenantId, operatorId],
      );
    });
    return { token, tenantId, operatorId };
  }

  async login(email: string, password: string) {
    const { email: cleanEmail, password: cleanPassword } =
      credentialsSchema.parse({ email, password });
    const found = await this.pool.query(
      "SELECT tenant_id, operator_id, password_hash FROM morrow.lookup_merchant_identity($1)",
      [hash(cleanEmail)],
    );
    const row = found.rows[0];
    // Generic refusal either way; no tenant or identity facts leak.
    if (!row || !verifyPassword(cleanPassword, row.password_hash))
      throw new DomainError("INVALID_CREDENTIALS", 401);
    return this.issueSession(row.tenant_id, row.operator_id);
  }

  async loginWithPrivy(accessToken: string) {
    if (!this.privy)
      throw new DomainError("IDENTITY_PROVIDER_UNAVAILABLE", 503);
    if (
      accessToken.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)
    )
      throw new DomainError("INVALID_CREDENTIALS", 401);

    let claims: Awaited<ReturnType<typeof verifyAccessToken>>;
    try {
      claims = await this.verifyPrivyToken({
        access_token: accessToken,
        app_id: this.privy.appId,
        verification_key: this.privy.verificationKey,
      });
    } catch {
      // Provider/token details are deliberately not exposed or logged.
      throw new DomainError("INVALID_CREDENTIALS", 401);
    }
    if (
      claims.app_id !== this.privy.appId ||
      claims.issuer !== "privy.io" ||
      !claims.user_id
    )
      throw new DomainError("INVALID_CREDENTIALS", 401);

    const subjectHash = createHash("sha256")
      .update("morrow:privy-user:v1\0")
      .update(this.privy.appId)
      .update("\0")
      .update(claims.user_id)
      .digest("hex");
    const found = await this.pool.query(
      "SELECT tenant_id,operator_id FROM morrow.lookup_merchant_privy_identity($1,$2)",
      [this.privy.appId, subjectHash],
    );
    const row = found.rows[0];
    if (!row) throw new DomainError("INVALID_CREDENTIALS", 401);
    return this.issueSession(row.tenant_id, row.operator_id);
  }

  async authenticate(token: string): Promise<Actor> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new DomainError("AUTHENTICATION_REQUIRED", 401);
    const session = await this.pool.query(
      "SELECT tenant_id, operator_id FROM morrow.consume_merchant_session($1)",
      [tokenHash(token)],
    );
    const row = session.rows[0];
    if (!row) throw new DomainError("AUTHENTICATION_REQUIRED", 401);
    const actor = actorSchema.parse({
      tenantId: row.tenant_id,
      operatorId: row.operator_id,
      role: "merchant",
    });
    // Re-verify the operator and tenant kind inside tenant context.
    await tenantTransaction(this.pool, actor.tenantId, async (db) => {
      await authorize(db, actor);
    });
    return actor;
  }

  async logout(token: string) {
    await this.pool.query(
      "SELECT tenant_id FROM morrow.delete_merchant_session($1)",
      [tokenHash(token)],
    );
  }

  async policyVersion(actor: Actor): Promise<number> {
    actorSchema.parse(actor);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const authorizePolicy = await authorize(db, actor);
      return authorizePolicy.policy_version;
    });
  }

  async queue(actor: Actor, query?: string) {
    actorSchema.parse(actor);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorize(db, actor);
      const where = ["c.tenant_id=$1"];
      const params: unknown[] = [actor.tenantId];
      if (query) {
        // Exact tenant-scoped contract: case UUID or the order reference
        // hash only. No substring search, no other tenant's cases.
        const trimmed = query.trim();
        if (z.uuid().safeParse(trimmed).success) {
          params.push(trimmed);
          where.push(`c.id=$${params.length}`);
        } else {
          params.push(hash(trimmed.toUpperCase()));
          where.push(
            `c.id IN (SELECT c2.id FROM morrow.order_refs r JOIN morrow.cases c2 ON c2.tenant_id=r.tenant_id AND c2.order_id=r.order_id WHERE r.reference_hash=$${params.length})`,
          );
        }
      }
      const rows = await db.query(
        `SELECT c.id AS case_id, c.order_id, c.version,
                o.product_id,p.expires_at AS intent_expires_at,
                EXISTS(SELECT 1 FROM morrow.repairs r WHERE r.tenant_id=c.tenant_id AND r.case_id=c.id) AS executed,
                (pc.verdict='MATCH') AS payment_attested,
                pc.verdict AS latest_verdict, pc.checked_at,
                e.granted_at AS entitled_at, d.kind AS decision_kind, d.case_version AS decision_case_version, d.policy_version AS decision_policy_version
         FROM morrow.cases c
         JOIN morrow.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id
         LEFT JOIN morrow.payment_intents p ON p.tenant_id=c.tenant_id AND p.order_id=c.order_id
         LEFT JOIN LATERAL (
           SELECT verdict, checked_at FROM morrow.payment_checks
           WHERE tenant_id=c.tenant_id AND case_id=c.id
           ORDER BY checked_at DESC LIMIT 1
         ) pc ON true
         LEFT JOIN morrow.entitlements e ON e.tenant_id=c.tenant_id AND e.order_id=c.order_id AND e.product_id=o.product_id
         LEFT JOIN LATERAL (
           SELECT kind,case_version,policy_version FROM morrow.decisions
           WHERE tenant_id=c.tenant_id AND case_id=c.id ORDER BY case_version DESC LIMIT 1
         ) d ON true
         WHERE ${where.join(" AND ")}
         ORDER BY pc.checked_at DESC NULLS LAST, c.id DESC
         LIMIT 50`,
        params,
      );
      return {
        cases: rows.rows.map((r) => ({
          summary: projectCase(
            {
              payment: {
                verdict: r.latest_verdict ?? "NOT_CHECKED",
                checkedAt: r.checked_at,
              },
              intentExpiresAt: r.intent_expires_at,
              decision: r.decision_kind
                ? {
                    kind: r.decision_kind,
                    current:
                      r.decision_case_version === r.version &&
                      r.decision_policy_version === policy.policy_version,
                  }
                : null,
              policyEnabled: policy.grant_enabled,
              entitled: !!r.entitled_at,
              executed: r.executed,
            },
            "merchant",
          ),
          caseId: r.case_id,
          orderId: r.order_id,
          version: r.version,
          paymentAttested: r.payment_attested === true,
          paymentVerdict: r.latest_verdict ?? "NOT_CHECKED",
          access: r.entitled_at ? "RESTORED" : "MISSING",
          decision: r.decision_kind
            ? {
                kind: r.decision_kind,
                current:
                  r.decision_case_version === r.version &&
                  r.decision_policy_version === policy.policy_version,
              }
            : null,
        })),
      };
    });
  }

  async detail(actor: Actor, caseId: string) {
    actorSchema.parse(actor);
    z.uuid().parse(caseId);
    return tenantTransaction(this.pool, actor.tenantId, async (db) => {
      const policy = await authorize(db, actor);
      const caseRow = await db.query(
        `SELECT c.id, c.version, c.order_id, o.product_id,o.product_category,o.customer_label,o.product_label,o.display_reference,
                p.network, p.expected_digest, p.sender, p.recipient, p.coin_type,
                p.amount::text AS amount, p.created_at AS intent_created_at, p.expires_at AS intent_expires_at
         FROM morrow.cases c
         JOIN morrow.orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id
         LEFT JOIN morrow.payment_intents p ON p.tenant_id=o.tenant_id AND p.order_id=o.id
         WHERE c.tenant_id=$1 AND c.id=$2`,
        [actor.tenantId, caseId],
      );
      const c = caseRow.rows[0];
      if (!c) throw new DomainError("CASE_NOT_FOUND", 404);
      const checks = await db.query(
        `SELECT verdict, reason, evidence, checked_at FROM morrow.payment_checks
         WHERE tenant_id=$1 AND case_id=$2 ORDER BY checked_at DESC LIMIT 5`,
        [actor.tenantId, caseId],
      );
      const access = await db.query(
        "SELECT granted_at FROM morrow.entitlements WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3",
        [actor.tenantId, c.order_id, c.product_id],
      );
      const decisions = await db.query(
        `SELECT id, kind, case_version, policy_version, created_at FROM morrow.decisions
         WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 10`,
        [actor.tenantId, caseId],
      );
      const repairs = await db.query(
        `SELECT id, decision_id, created_at FROM morrow.repairs
         WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 5`,
        [actor.tenantId, caseId],
      );
      const events = await db.query(
        `SELECT id, kind, data, created_at FROM morrow.case_events
         WHERE tenant_id=$1 AND case_id=$2 ORDER BY id DESC LIMIT 20`,
        [actor.tenantId, caseId],
      );
      const lessons = await db.query(
        `SELECT id, state, job_id, blob_id, fingerprint, policy_version, network FROM morrow.lessons
         WHERE tenant_id=$1 AND case_id=$2 ORDER BY id LIMIT 5`,
        [actor.tenantId, caseId],
      );
      const request = await db.query(
        "SELECT issue FROM morrow.help_requests WHERE tenant_id=$1 AND case_id=$2",
        [actor.tenantId, caseId],
      );
      const latestCheck = checks.rows[0];
      return {
        caseId,
        summary: projectCase(
          {
            payment: {
              verdict: latestCheck?.verdict ?? "NOT_CHECKED",
              checkedAt: latestCheck?.checked_at,
            },
            intentExpiresAt: c.intent_expires_at,
            decision: decisions.rows[0]
              ? {
                  kind: decisions.rows[0].kind,
                  current:
                    decisions.rows[0].case_version === c.version &&
                    decisions.rows[0].policy_version === policy.policy_version,
                }
              : null,
            policyEnabled: policy.grant_enabled,
            entitled: access.rowCount === 1,
            executed: repairs.rows.length > 0,
          },
          "merchant",
        ),
        scenario: c.customer_label
          ? {
              customer: c.customer_label,
              product: c.product_label,
              reference: c.display_reference,
              category: c.product_category,
            }
          : null,
        issue: request.rows[0]?.issue ?? null,
        caseVersion: c.version,
        orderId: c.order_id,
        paymentAttested: latestCheck?.verdict === "MATCH",
        evidence: {
          intent: c.expected_digest
            ? {
                network: c.network,
                digest: c.expected_digest,
                sender: c.sender,
                recipient: c.recipient,
                coinType: c.coin_type,
                amount: c.amount,
                createdAt: c.intent_created_at,
                expiresAt: c.intent_expires_at,
              }
            : null,
          latestCheck: latestCheck
            ? {
                verdict: latestCheck.verdict,
                reason: latestCheck.reason,
                evidence: latestCheck.evidence,
                checkedAt: latestCheck.checked_at,
              }
            : null,
          checks: checks.rows,
        },
        access: access.rowCount === 1 ? "RESTORED" : "MISSING",
        entitledAt: access.rows[0]?.granted_at ?? null,
        repairs: repairs.rows,
        policy: {
          policyVersion: policy.policy_version,
          grantEnabled: policy.grant_enabled,
          staleDecisions: decisions.rows.filter(
            (d) => d.policy_version !== policy.policy_version,
          ),
        },
        decisions: decisions.rows,
        events: events.rows,
        lessons: lessons.rows,
      };
    });
  }
}
