import type { PoolClient } from "pg";
import { z } from "zod";
import { DomainError } from "./errors.js";

export const actorSchema = z
  .object({
    tenantId: z.uuid(),
    operatorId: z.uuid(),
    role: z.enum(["merchant", "judge"]),
  })
  .strict();
export type Actor = z.infer<typeof actorSchema>;

/** Hold shared locks until commit so rights or policy cannot change during an effect. */
export async function authorizeOperator(db: PoolClient, actor: Actor) {
  const r = await db.query(
    `SELECT o.role,t.kind,t.policy_version,t.grant_enabled FROM morrow.operators o
    JOIN morrow.tenants t ON t.id=o.tenant_id WHERE o.tenant_id=$1 AND o.id=$2 AND o.active=true FOR SHARE OF o,t`,
    [actor.tenantId, actor.operatorId],
  );
  const row = r.rows[0];
  if (
    !row ||
    row.role !== actor.role ||
    (actor.role === "judge" ? row.kind !== "demo" : row.kind !== "merchant")
  )
    throw new DomainError("FORBIDDEN", 403);
  return row as {
    role: string;
    kind: string;
    policy_version: number;
    grant_enabled: boolean;
  };
}
