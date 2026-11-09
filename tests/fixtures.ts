import { randomUUID } from "node:crypto";
import { tenantTransaction, type Database } from "../src/database.js";
import type { PaymentEvidence } from "../src/payment.js";
import type { Actor } from "../src/authorization.js";

// Fictional provider evidence for regression tests only. Never used by the runtime gateway.
export async function seedCase(
  pool: Database,
  options: { digest?: string } = {},
) {
  const tenantId = randomUUID(),
    operatorId = randomUUID(),
    orderId = randomUUID(),
    caseId = randomUUID();
  const digest =
    options.digest ??
    randomUUID().replace(/-/g, "").replace(/0/g, "1").replace(/l/g, "L");
  const actor: Actor = { tenantId, operatorId, role: "judge" };
  const sender = `0x${"1".repeat(64)}`,
    recipient = `0x${"2".repeat(64)}`;
  const times = await tenantTransaction(pool, tenantId, async (db) => {
    await db.query(
      "INSERT INTO morrow.tenants(id,kind,grant_enabled) VALUES ($1,'demo',true)",
      [tenantId],
    );
    await db.query(
      "INSERT INTO morrow.operators(tenant_id,id,role) VALUES ($1,$2,'judge')",
      [tenantId, operatorId],
    );
    await db.query(
      "INSERT INTO morrow.orders(tenant_id,id,customer_id,product_id) VALUES ($1,$2,$3,$4)",
      [tenantId, orderId, randomUUID(), randomUUID()],
    );
    const result = await db.query(
      `INSERT INTO morrow.payment_intents(tenant_id,order_id,network,expected_digest,sender,recipient,coin_type,amount,expires_at)
      VALUES ($1,$2,'testnet',$3,$4,$5,'0x2::sui::SUI',1000000,clock_timestamp()+interval '10 minutes') RETURNING created_at`,
      [tenantId, orderId, digest, sender, recipient],
    );
    await db.query(
      "INSERT INTO morrow.cases(tenant_id,id,order_id) VALUES ($1,$2,$3)",
      [tenantId, caseId, orderId],
    );
    return result.rows[0];
  });
  const evidence: PaymentEvidence = {
    provider: "tatum",
    method: "sui.rpc.v2.LedgerService/GetTransaction",
    network: "testnet",
    digest,
    status: "SUCCESS",
    checkpoint: "42",
    sender,
    timestamp: new Date(times.created_at.getTime() + 1).toISOString(),
    checkedAt: new Date().toISOString(),
    balanceChanges: [
      { address: recipient, coinType: "0x2::sui::SUI", amount: "1000000" },
    ],
  };
  return { actor, caseId, orderId, evidence };
}

// Merchant fixture case for S5 tests: kind merchant + role merchant, so the
// judge/demo authorization path is never involved. Evidence stays fictional.
export async function seedMerchantCase(
  pool: Database,
  options: { digest?: string } = {},
) {
  const tenantId = randomUUID(),
    operatorId = randomUUID(),
    orderId = randomUUID(),
    caseId = randomUUID();
  const digest =
    options.digest ??
    randomUUID().replace(/-/g, "").replace(/0/g, "1").replace(/l/g, "L");
  const actor: Actor = { tenantId, operatorId, role: "merchant" };
  const sender = `0x${"3".repeat(64)}`,
    recipient = `0x${"4".repeat(64)}`;
  await tenantTransaction(pool, tenantId, async (db) => {
    await db.query(
      "INSERT INTO morrow.tenants(id,kind,grant_enabled) VALUES ($1,'merchant',true)",
      [tenantId],
    );
    await db.query(
      "INSERT INTO morrow.operators(tenant_id,id,role) VALUES ($1,$2,'merchant')",
      [tenantId, operatorId],
    );
    await db.query(
      "INSERT INTO morrow.orders(tenant_id,id,customer_id,product_id) VALUES ($1,$2,$3,$4)",
      [tenantId, orderId, randomUUID(), randomUUID()],
    );
    await db.query(
      `INSERT INTO morrow.payment_intents(tenant_id,order_id,network,expected_digest,sender,recipient,coin_type,amount,expires_at)
      VALUES ($1,$2,'testnet',$3,$4,$5,'0x2::sui::SUI',1000000,clock_timestamp()+interval '10 minutes')`,
      [tenantId, orderId, digest, sender, recipient],
    );
    await db.query(
      "INSERT INTO morrow.cases(tenant_id,id,order_id) VALUES ($1,$2,$3)",
      [tenantId, caseId, orderId],
    );
  });
  return { actor, caseId, orderId, digest };
}
