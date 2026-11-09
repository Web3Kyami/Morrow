import { readFile } from "node:fs/promises";
import { Transaction } from "@mysten/sui/transactions";
import { z } from "zod";
import { tatumClient } from "../src/providers/tatum.js";
// @ts-expect-error - shared helper is plain JS without declarations
import { loadSuiSigner } from "/root/.agents/skills/kyami-development/scripts/sui-test-wallet.mjs";

/**
 * Signs and submits the EXACT unsigned bytes from payment:reserve with the
 * shared Sui Testnet payer (sui-test-2) via Tatum. Testnet only.
 */
const reservationSchema = z.object({
  network: z.literal("testnet"),
  digest: z.string(),
  sender: z.string(),
  recipient: z.string(),
  amount: z.string(),
  transactionBytes: z.string(),
});

if (process.env.SUI_PAYMENT_NETWORK !== "testnet")
  throw new Error("TESTNET_REQUIRED");
const key = process.env.TATUM_API_KEY;
if (!key) throw new Error("TATUM_API_KEY missing");

const reservation = reservationSchema.parse(
  JSON.parse(
    await readFile(
      process.env.MORROW_RESERVATION_PATH ?? ".morrow/payment-reservation.json",
      "utf8",
    ),
  ),
);
const bytes = Uint8Array.from(
  Buffer.from(reservation.transactionBytes, "base64"),
);
if ((await Transaction.from(bytes).getDigest()) !== reservation.digest)
  throw new Error("RESERVED_DIGEST_MISMATCH");

const signer = await loadSuiSigner("sui-test-2");
if (signer.toSuiAddress() !== reservation.sender)
  throw new Error("PAYER_ADDRESS_MISMATCH");

const { client, close } = tatumClient(key);
try {
  const { signature } = await signer.signTransaction(bytes);
  const result = await client.executeTransaction({
    transaction: bytes,
    signatures: [signature],
  });
  const executed = result?.Transaction;
  console.log(
    `executed digest: ${executed?.digest ?? "unknown"} success: ${executed?.status?.success ?? "?"}`,
  );
  if (!executed?.digest || executed.digest !== reservation.digest)
    throw new Error("EXECUTED_DIGEST_MISMATCH");
  const confirmed = await client.waitForTransaction({
    digest: reservation.digest,
  });
  console.log(
    `checkpoint: ${confirmed?.Transaction?.checkpoint ?? "pending"} success: ${confirmed?.Transaction?.status?.success ?? "?"}`,
  );
  const recipient = await client.getBalance({
    owner: reservation.recipient,
    coinType: "0x2::sui::SUI",
  });
  console.log(`recipient balance: ${recipient.balance?.balance ?? "?"}`);
} finally {
  close();
}
