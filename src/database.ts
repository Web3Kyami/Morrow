import pg from "pg";
import type { PoolClient } from "pg";

export function createPool(url: string) {
  const connection = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(connection.hostname))
    connection.searchParams.set("sslmode", "verify-full");
  return new pg.Pool({
    connectionString: connection.toString(),
    max: 8,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: "morrow-foundation",
  });
}
export type Database = ReturnType<typeof createPool>;

export async function assertRuntimeRole(pool: Database) {
  const r = await pool.query(`SELECT r.rolsuper,r.rolbypassrls,
    has_schema_privilege(current_user,'morrow','CREATE') AS can_ddl,
    has_column_privilege(current_user,'morrow.tenants','policy_version','UPDATE') AS can_policy,
    has_column_privilege(current_user,'morrow.operators','active','UPDATE') AS can_authorize
    FROM pg_roles r WHERE r.rolname=current_user`);
  const role = r.rows[0];
  if (
    !role ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.can_ddl ||
    role.can_policy ||
    role.can_authorize
  )
    throw new Error("RESTRICTED_RUNTIME_ROLE_REQUIRED");
}

export async function tenantTransaction<T>(
  pool: Database,
  tenantId: string,
  work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('morrow.tenant_id',$1,true)", [tenantId]);
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
