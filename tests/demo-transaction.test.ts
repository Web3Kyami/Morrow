import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { validateDemoTransaction } from "../src/demo-transaction.js";
const payer = "0x" + "1".repeat(64),
  recipient = "0x" + "2".repeat(64);
async function intent(amount = 1000000n) {
  const tx = new Transaction();
  tx.setSender(payer);
  tx.setGasOwner(payer);
  tx.setGasBudget(2000000);
  tx.setGasPrice(1000);
  tx.setGasPayment([
    { objectId: "0x" + "3".repeat(64), version: "1", digest: "1".repeat(32) },
  ]);
  const [c] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([c!], recipient);
  const bytes = await tx.build();
  return {
    digest: await tx.getDigest(),
    transactionBytes: Buffer.from(bytes).toString("base64"),
    sender: payer,
    recipient,
    amount: amount.toString(),
    gasBudget: "2000000",
    gasRefs: tx
      .getData()
      .gasData.payment!.map((g) => `${g.objectId}:${g.version}:${g.digest}`),
  };
}
test("signer accepts only the exact reserved native transfer to fixed registered roles", async () => {
  const i = await intent();
  assert.ok((await validateDemoTransaction(i, payer, recipient)).length);
  await assert.rejects(() =>
    validateDemoTransaction({ ...i, recipient: payer }, payer, recipient),
  );
  await assert.rejects(() =>
    validateDemoTransaction({ ...i, digest: "2".repeat(44) }, payer, recipient),
  );
  await assert.rejects(() =>
    validateDemoTransaction({ ...i, gasRefs: [] }, payer, recipient),
  );
  await assert.rejects(() =>
    validateDemoTransaction({ ...i, amount: "1000001" }, payer, recipient),
  );
  await assert.rejects(() =>
    validateDemoTransaction({ ...i, gasBudget: "12000000" }, payer, recipient),
  );
  const oversized = await intent(1500001n);
  await assert.rejects(() =>
    validateDemoTransaction(oversized, payer, recipient),
  );
});
