import { memoryConfig } from "./config.js";
import { tenantTransaction, type Database } from "./database.js";
import { tatumClient } from "./providers/tatum.js";
import { authorizeOperator, type Actor } from "./authorization.js";

type ProviderState =
  "CONNECTED" | "CONFIGURED" | "UNAVAILABLE" | "NOT_CONFIGURED" | "DEFERRED";

/** Read-only merchant diagnostics. This never submits a payment or memory write. */
export async function merchantProviderStatus(
  pool: Database,
  actor: Actor,
  env: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = new Date().toISOString();
  const database = await tenantTransaction(pool, actor.tenantId, async (db) => {
    await authorizeOperator(db, actor);
    await db.query("SELECT 1");
    const latest = await db.query(
      `SELECT state,blob_id,recalled_at,completed_at
       FROM morrow.lessons WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [actor.tenantId],
    );
    const counts = await db.query(
      `SELECT state,count(*)::int AS count FROM morrow.lessons
       WHERE tenant_id=$1 GROUP BY state`,
      [actor.tenantId],
    );
    return {
      state: "CONNECTED" as const,
      lesson: latest.rows[0]
        ? {
            state: latest.rows[0].state as string,
            blobPresent: latest.rows[0].blob_id !== null,
            completedAt: latest.rows[0].completed_at as Date | null,
            recalledAt: latest.rows[0].recalled_at as Date | null,
          }
        : null,
      lessonCounts: Object.fromEntries(
        counts.rows.map((row) => [row.state as string, row.count as number]),
      ),
    };
  });

  let tatum: { state: ProviderState; chainId?: string; detail?: string };
  if (!env.TATUM_API_KEY) {
    tatum = { state: "NOT_CONFIGURED" };
  } else {
    const { client, close } = tatumClient(env.TATUM_API_KEY);
    try {
      const { response } = await client.ledgerService.getServiceInfo(
        {},
        { meta: { "x-api-key": env.TATUM_API_KEY }, timeout: 10_000 },
      );
      tatum = response.chainId
        ? { state: "CONNECTED", chainId: response.chainId }
        : { state: "UNAVAILABLE", detail: "CHAIN_ID_MISSING" };
    } catch {
      tatum = { state: "UNAVAILABLE", detail: "PROVIDER_CHECK_FAILED" };
    } finally {
      close();
    }
  }

  let walrus: {
    state: ProviderState;
    network: "testnet" | "mainnet" | null;
    latestLesson: typeof database.lesson;
    lessonCounts: typeof database.lessonCounts;
  };
  try {
    const config = memoryConfig(env);
    walrus = {
      state: config.network === "testnet" ? "CONFIGURED" : "DEFERRED",
      network: config.network,
      latestLesson: database.lesson,
      lessonCounts: database.lessonCounts,
    };
  } catch {
    walrus = {
      state: "NOT_CONFIGURED",
      network: null,
      latestLesson: database.lesson,
      lessonCounts: database.lessonCounts,
    };
  }

  return {
    checkedAt,
    database: { state: database.state },
    tatum: { network: "testnet" as const, ...tatum },
    walrus,
    note: "Tatum is checked read-only. Walrus shows configuration and persisted lesson evidence; no live storage probe is run.",
  };
}
