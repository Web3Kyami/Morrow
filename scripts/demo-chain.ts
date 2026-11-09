import type { DemoChain } from "../src/demo-payment-worker.js";
import { buildTatumDemoIntent } from "../src/demo-provisioning.js";
import { validateDemoTransaction } from "../src/demo-transaction.js";
import { tatumClient } from "../src/providers/tatum.js";
// @ts-expect-error - owner-only shared helper is plain JavaScript.
import { loadSuiSigner } from "/root/.agents/skills/kyami-development/scripts/sui-test-wallet.mjs";
// @ts-expect-error - owner-only shared helper is plain JavaScript.
import { readRegistry } from "/root/.agents/skills/kyami-development/scripts/sui-test-wallet.mjs";

/** Worker-only adapter. Never import this module into the HTTP runtime. */
export async function createDemoChain(): Promise<{
  chain: DemoChain;
  close: () => void;
}> {
  if (
    process.env.SUI_PAYMENT_NETWORK !== "testnet" ||
    !process.env.TATUM_API_KEY
  )
    throw Error("TESTNET_REQUIRED");
  const registry = readRegistry();
  const payer = registry.accounts.find(
    (a: { id: string }) => a.id === "sui-test-2",
  )?.address;
  const recipient = registry.accounts.find(
    (a: { id: string }) => a.id === "sui-test-3",
  )?.address;
  if (
    !payer ||
    !recipient ||
    payer !== process.env.DEMO_SUI_PAYER_ADDRESS ||
    recipient !== process.env.DEMO_SUI_RECIPIENT_ADDRESS
  )
    throw Error("REGISTERED_DEMO_ROLES_REQUIRED");
  const { client, close } = tatumClient(process.env.TATUM_API_KEY);
  const network = await client.ledgerService.getServiceInfo({});
  if (network.response.chain !== "testnet") {
    close();
    throw Error("TESTNET_REQUIRED");
  }
  const chain: DemoChain = {
    prepare: async () =>
      buildTatumDemoIntent({
        TATUM_API_KEY: process.env.TATUM_API_KEY,
        DEMO_SUI_PAYER_ADDRESS: payer,
        DEMO_SUI_RECIPIENT_ADDRESS: recipient,
        SUI_PAYMENT_NETWORK: "testnet",
      }),
    observe: async (digest) => {
      try {
        const { response } = await client.ledgerService.getTransaction({
          digest,
          readMask: { paths: ["digest", "checkpoint", "effects.status"] },
        });
        if (
          response.transaction?.checkpoint &&
          response.transaction.effects?.status?.success === true
        )
          return "SUCCESS";
        if (response.transaction?.effects?.status?.success === false)
          return "FAILED";
        return "UNKNOWN";
      } catch (e) {
        const code = (e as { code?: string | number }).code;
        return code === "NOT_FOUND" || code === 5 ? "ABSENT" : "UNKNOWN";
      }
    },
    submit: async (intent) => {
      const bytes = await validateDemoTransaction(intent, payer, recipient);
      const signer = await loadSuiSigner("sui-test-2");
      if (signer.toSuiAddress() !== payer) throw Error("SIGNER_MISMATCH");
      const { signature } = await signer.signTransaction(bytes);
      const result = await client.executeTransaction({
        transaction: bytes,
        signatures: [signature],
      });
      if (result.Transaction?.digest !== intent.digest)
        throw Error("SUBMISSION_UNCERTAIN");
      const confirmed = await client.waitForTransaction({
        digest: intent.digest,
      });
      if (
        !confirmed.Transaction?.checkpoint ||
        confirmed.Transaction.status?.success !== true
      )
        throw Error("CONFIRMATION_UNCERTAIN");
    },
  };
  return { chain, close };
}
