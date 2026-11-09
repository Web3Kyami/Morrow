import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createPool, tenantTransaction } from "../src/database.js";

/** One-off: attach a customer-facing order reference to the reserved demo
 *  order (Case A) so S4 intake can find it. Plain values stay in .morrow/. */
const reservationSchema = z.object({
  tenantId: z.uuid(),
  orderId: z.uuid(),
  caseId: z.uuid(),
  orderRef: z.string().optional(),
  demoEmail: z.string().optional(),
});

const reservation = reservationSchema.parse(
  JSON.parse(await readFile(".morrow/payment-reservation.json", "utf8")),
);
const url = process.env.DIRECT_URL;
if (!url) {
  console.log("BLOCKED: DIRECT_URL missing");
  process.exitCode = 1;
} else {
  const orderRef =
    reservation.orderRef ??
    `MRW-${randomBytes(4).toString("hex").toUpperCase()}`;
  const demoEmail = reservation.demoEmail ?? "buyer@example.test";
  const hash = (value: string) =>
    createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
  const pool = createPool(url);
  try {
    await tenantTransaction(pool, reservation.tenantId, async (db) => {
      await db.query(
        `INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, order_id) DO NOTHING`,
        [
          reservation.tenantId,
          reservation.orderId,
          hash(orderRef),
          hash(demoEmail),
        ],
      );
    });
    await writeFile(
      ".morrow/demo-order-ref.json",
      JSON.stringify(
        {
          orderRef,
          demoEmail,
          tenantId: reservation.tenantId,
          caseId: reservation.caseId,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      `PASS: demo order reference seeded for case ${reservation.caseId} (private file)`,
    );
  } finally {
    await pool.end();
  }
}
