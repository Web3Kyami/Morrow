import { Transaction } from "@mysten/sui/transactions";
import { tatumClient } from "../src/providers/tatum.js";
// @ts-expect-error - shared helper is plain JS without declarations
import { loadSuiSigner } from "/root/.agents/skills/kyami-development/scripts/sui-test-wallet.mjs";

/**
 * Testnet-only funding of the demo payer (sui-test-2) from the hub (sui-test-1).
 * Builds, signs and submits one small native SUI transfer. Never touches mainnet.
 */
const HUB =
  "0x995b33b197e98d20baa396d3760b6aad8141af742b661971efdc8b542c144674";
const PAYER =
  "0x15ba6b9a67261d9858055b7f5a9192ccad76d126ebdc562369aee0ff2b1eac56";
const AMOUNT = 100_000_000n; // 0.1 SUI

if (process.env.SUI_PAYMENT_NETWORK !== "testnet")
  throw new Error("TESTNET_REQUIRED");
const key = process.env.TATUM_API_KEY;
if (!key) throw new Error("TATUM_API_KEY missing");

const signer = await loadSuiSigner("sui-test-1");
if (signer.toSuiAddress() !== HUB) throw new Error("HUB_ADDRESS_MISMATCH");

const { client, close } = tatumClient(key);
try {
  const before = await client.getBalance({
    owner: PAYER,
    coinType: "0x2::sui::SUI",
  });
  console.log(`payer before: ${before.balance?.balance ?? "?"}`);
  const tx = new Transaction();
  tx.setSender(HUB);
  const [coin] = tx.splitCoins(tx.gas, [AMOUNT]);
  tx.transferObjects([coin!], PAYER);
  const bytes = await tx.build({ client });
  const { signature } = await signer.signTransaction(bytes);
  const result = await client.executeTransaction({
    transaction: bytes,
    signatures: [signature],
  });
  const executed = result.Transaction;
  const digest = executed?.digest ?? null;
  console.log(`submitted digest: ${digest ?? "unknown"}`);
  if (!digest) throw new Error("EXECUTE_NO_DIGEST");
  const confirmed = await client.waitForTransaction({ digest });
  const confirmedTx = confirmed.Transaction;
  console.log(
    `confirmed digest: ${confirmedTx?.digest ?? digest} status: ${confirmedTx?.status?.success ?? "?"}`,
  );
  const after = await client.getBalance({
    owner: PAYER,
    coinType: "0x2::sui::SUI",
  });
  console.log(`payer after: ${after.balance?.balance ?? "?"}`);
} finally {
  close();
}
