import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { z } from "zod";
import { createPool, tenantTransaction } from "../src/database.js";
import { tatumClient } from "../src/providers/tatum.js";

async function reserve() {
  const required = [
    "DIRECT_URL",
    "TATUM_API_KEY",
    "DEMO_SUI_PAYER_ADDRESS",
    "DEMO_SUI_RECIPIENT_ADDRESS",
  ];
  const missing = required.filter((n) => !process.env[n]);
  if (missing.length) {
    console.log(`BLOCKED: ${missing.join(", ")} missing`);
    process.exitCode = 1;
    return;
  }
  if (process.env.SUI_PAYMENT_NETWORK !== "testnet")
    throw new Error("TESTNET_REQUIRED");
  const address = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
  const sender = normalizeSuiAddress(
    address.parse(process.env.DEMO_SUI_PAYER_ADDRESS),
  );
  const recipient = normalizeSuiAddress(
    address.parse(process.env.DEMO_SUI_RECIPIENT_ADDRESS),
  );
  if (sender === recipient) throw new Error("DISTINCT_RECIPIENT_REQUIRED");
  const { client, close } = tatumClient(process.env.TATUM_API_KEY!);
  const tx = new Transaction();
  tx.setSender(sender);
  const amount = 1_000_000n;
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([coin!], recipient);
  let bytes: Uint8Array;
  try {
    bytes = await tx.build({ client });
  } finally {
    close();
  }
  const digest = await Transaction.from(bytes).getDigest();
  const tenantId = randomUUID(),
    operatorId = randomUUID(),
    caseId = randomUUID(),
    orderId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  // Customer-facing order reference for S4 intake. Only the hashes persist;
  // the plain reference lives in the private reservation file only.
  const orderRef = `MRW-${randomBytes(4).toString("hex").toUpperCase()}`;
  const demoEmail = "buyer@example.test";
  const hash = (value: string) =>
    createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
  await mkdir(".morrow", { recursive: true, mode: 0o700 });
  // Reserve the output path before DB writes to avoid overwriting an existing signing workflow.
  const path =
    process.env.MORROW_RESERVATION_OUT ?? ".morrow/payment-reservation.json";
  const file = await import("node:fs/promises").then((fs) =>
    fs.open(path, "wx", 0o600),
  );
  const pool = createPool(process.env.DIRECT_URL!);
  try {
    await tenantTransaction(pool, tenantId, async (db) => {
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
      await db.query(
        `INSERT INTO morrow.payment_intents(tenant_id,order_id,network,expected_digest,sender,recipient,coin_type,amount,expires_at)
        VALUES ($1,$2,'testnet',$3,$4,$5,'0x2::sui::SUI',$6,clock_timestamp()+interval '30 minutes')`,
        [tenantId, orderId, digest, sender, recipient, amount.toString()],
      );
      await db.query(
        "INSERT INTO morrow.cases(tenant_id,id,order_id) VALUES ($1,$2,$3)",
        [tenantId, caseId, orderId],
      );
      await db.query(
        "INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash) VALUES ($1,$2,$3,$4)",
        [tenantId, orderId, hash(orderRef), hash(demoEmail)],
      );
      await db.query(
        `INSERT INTO morrow.demo_sessions(token_hash,tenant_id,operator_id,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,
        [
          createHash("sha256").update(token).digest("hex"),
          tenantId,
          operatorId,
        ],
      );
    });
    await file.writeFile(
      JSON.stringify(
        {
          network: "testnet",
          tenantId,
          operatorId,
          caseId,
          orderId,
          digest,
          sender,
          recipient,
          amount: amount.toString(),
          transactionBytes: Buffer.from(bytes).toString("base64"),
          orderRef,
          demoEmail,
        },
        null,
        2,
      ),
    );
    const sessionPath = path.replace("payment-reservation", "demo-session");
    await writeFile(sessionPath, JSON.stringify({ token, tenantId, caseId }), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      "PASS: unsigned native SUI transfer reserved before broadcast. Existing signer must sign these exact bytes on Sui Testnet; no transaction was signed or sent.",
    );
    console.log(`Public Testnet payer: ${sender}`);
  } finally {
    await file.close();
    await pool.end();
  }
}
await reserve().catch(() => {
  console.error(
    "FAIL: payment reservation; check private configuration and existing reservation before retry",
  );
  process.exitCode = 1;
});
