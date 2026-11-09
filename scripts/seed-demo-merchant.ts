import { randomBytes, randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { createPool, tenantTransaction } from "../src/database.js";
import { hashPassword } from "../src/merchant.js";
import { hash } from "../src/customer.js";

/**
 * Seeds the S5 demo merchant fixture: one merchant tenant, fixture login,
 * and two cases showing MISSING / RESTORED access with ATTESTED /
 * NOT ATTESTED payment states. Fixture payment checks are labeled
 * source=demo-fixture; they are not live Tatum evidence.
 */
const url = process.env.DIRECT_URL;
if (!url) {
  console.log("BLOCKED: DIRECT_URL missing");
  process.exitCode = 1;
} else {
  const pool = createPool(url);
  try {
    await mkdir(".morrow", { recursive: true, mode: 0o700 });
    const email = "merchant@example.test";
    const password = randomBytes(12).toString("base64url") + "!";
    const tenantId = randomUUID(),
      operatorId = randomUUID();
    const cases: Array<{
      label: string;
      orderRef: string;
      matched: boolean;
      restored: boolean;
      mismatched?: boolean;
    }> = [
      {
        label: "missing",
        orderRef: "MRW-MERCH001",
        matched: true,
        restored: false,
      },
      {
        label: "restored",
        orderRef: "MRW-MERCH002",
        matched: false,
        restored: true,
      },
      {
        label: "mismatch",
        orderRef: "MRW-MERCH003",
        matched: false,
        restored: false,
        mismatched: true,
      },
    ];
    const written: Array<{ label: string; caseId: string; orderRef: string }> =
      [];
    await tenantTransaction(pool, tenantId, async (db) => {
      await db.query(
        "INSERT INTO morrow.tenants(id,kind,policy_version,grant_enabled) VALUES ($1,'merchant',2,true)",
        [tenantId],
      );
      await db.query(
        "INSERT INTO morrow.operators(tenant_id,id,role) VALUES ($1,$2,'merchant')",
        [tenantId, operatorId],
      );
      await db.query(
        "INSERT INTO morrow.merchant_identities(email_hash,tenant_id,operator_id,password_hash) VALUES ($1,$2,$3,$4)",
        [hash(email), tenantId, operatorId, hashPassword(password)],
      );
      for (const item of cases) {
        const orderId = randomUUID(),
          caseId = randomUUID(),
          productId = randomUUID(),
          sender = `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`,
          recipient = `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`,
          digest = randomUUID().replace(/-/g, "").replace(/0/g, "1");
        await db.query(
          "INSERT INTO morrow.orders(tenant_id,id,customer_id,product_id) VALUES ($1,$2,$3,$4)",
          [tenantId, orderId, randomUUID(), productId],
        );
        await db.query(
          `INSERT INTO morrow.payment_intents(tenant_id,order_id,network,expected_digest,sender,recipient,coin_type,amount,expires_at)
           VALUES ($1,$2,'testnet',$3,$4,$5,'0x2::sui::SUI',1000000,clock_timestamp()+interval '30 minutes')`,
          [tenantId, orderId, digest, sender, recipient],
        );
        await db.query(
          "INSERT INTO morrow.cases(tenant_id,id,order_id) VALUES ($1,$2,$3)",
          [tenantId, caseId, orderId],
        );
        await db.query(
          "INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash) VALUES ($1,$2,$3,$4)",
          [tenantId, orderId, hash(item.orderRef), hash("buyer@example.test")],
        );
        if (item.matched) {
          await db.query(
            `INSERT INTO morrow.payment_checks(tenant_id,id,case_id,verdict,reason,evidence)
             VALUES ($1,$2,$3,'MATCH','PRECOMMITTED_PAYMENT_CONFIRMED',$4::jsonb)`,
            [
              tenantId,
              randomUUID(),
              caseId,
              JSON.stringify({
                provider: "tatum",
                method: "sui.rpc.v2.LedgerService/GetTransaction",
                network: "testnet",
                digest,
                status: "SUCCESS",
                checkpoint: "42",
                sender,
                source: "demo-fixture",
              }),
            ],
          );
        }
        if (item.mismatched) {
          await db.query(
            `INSERT INTO morrow.payment_checks(tenant_id,id,case_id,verdict,reason,evidence)
             VALUES ($1,$2,$3,'MISMATCH','RECIPIENT_ASSET_AMOUNT',$4::jsonb)`,
            [
              tenantId,
              randomUUID(),
              caseId,
              JSON.stringify({
                provider: "tatum",
                method: "sui.rpc.v2.LedgerService/GetTransaction",
                network: "testnet",
                digest,
                status: "SUCCESS",
                checkpoint: "42",
                sender,
                source: "demo-fixture",
                note: "Case C fixture: the observed payment does not match the registered order intent.",
              }),
            ],
          );
        }
        // Stale-policy evidence: a recorded decision at the old policy version.
        await db.query(
          "INSERT INTO morrow.decisions(tenant_id,id,case_id,operator_id,kind,case_version,policy_version) VALUES ($1,$2,$3,$4,'REJECTED',1,1)",
          [tenantId, randomUUID(), caseId, operatorId],
        );
        await db.query(
          "INSERT INTO morrow.case_events(tenant_id,case_id,operator_id,kind,data) VALUES ($1,$2,$3,'DECISION_RECORDED',$4::jsonb)",
          [tenantId, caseId, operatorId, JSON.stringify({ fixture: true })],
        );
        if (item.restored) {
          await db.query(
            "INSERT INTO morrow.entitlements(tenant_id,order_id,product_id) VALUES ($1,$2,$3)",
            [tenantId, orderId, productId],
          );
        }
        written.push({ label: item.label, caseId, orderRef: item.orderRef });
      }
    });
    await writeFile(
      ".morrow/demo-merchant.json",
      JSON.stringify({ email, password, tenantId, cases: written }, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      `PASS: demo merchant seeded with ${written.length} cases (credentials in private .morrow/demo-merchant.json)`,
    );
  } finally {
    await pool.end();
  }
}
