import assert from "node:assert/strict";
import test from "node:test";
import {
  matchPayment,
  type PaymentEvidence,
  type PaymentIntent,
} from "../src/payment.js";

const addr = (digit: string) => `0x${digit.repeat(64)}`;
export const intent: PaymentIntent = {
  network: "testnet",
  expectedDigest: "11111111111111111111111111111111",
  sender: addr("1"),
  recipient: addr("2"),
  coinType: "0x2::sui::SUI",
  amount: "1000000",
  createdAt: "2026-11-08T10:00:00.000Z",
  expiresAt: "2026-11-08T10:10:00.000Z",
};
export const evidence: PaymentEvidence = {
  provider: "tatum",
  method: "sui.rpc.v2.LedgerService/GetTransaction",
  network: "testnet",
  digest: intent.expectedDigest,
  status: "SUCCESS",
  checkpoint: "42",
  sender: intent.sender,
  timestamp: "2026-11-08T10:01:00.000Z",
  checkedAt: "2026-11-08T10:02:00.000Z",
  balanceChanges: [
    {
      address: intent.recipient,
      coinType: intent.coinType,
      amount: intent.amount,
    },
  ],
};

test("checkpointed payment matches only its precommitted order intent", () => {
  assert.equal(matchPayment(intent, evidence).verdict, "MATCH");
});

test("wrong digest, sender, recipient, asset, amount and post-payment intent all refuse", () => {
  for (const changed of [
    { ...evidence, digest: "22222222222222222222222222222222" },
    { ...evidence, sender: addr("3") },
    { ...evidence, status: "FAILED" as const },
    { ...evidence, timestamp: intent.createdAt },
    { ...evidence, timestamp: "2026-11-08T10:11:00.000Z" },
    {
      ...evidence,
      balanceChanges: [{ ...evidence.balanceChanges[0]!, address: addr("3") }],
    },
    {
      ...evidence,
      balanceChanges: [{ ...evidence.balanceChanges[0]!, amount: "1" }],
    },
    {
      ...evidence,
      balanceChanges: [
        { ...evidence.balanceChanges[0]!, coinType: "0x3::fake::SUI" },
      ],
    },
    {
      ...evidence,
      balanceChanges: [...evidence.balanceChanges, ...evidence.balanceChanges],
    },
  ])
    assert.notEqual(matchPayment(intent, changed).verdict, "MATCH");
});

test("missing finality or malformed provider data cannot become a match", () => {
  assert.equal(
    matchPayment(intent, { ...evidence, checkpoint: null }).verdict,
    "UNKNOWN",
  );
  assert.equal(
    matchPayment(intent, { ...evidence, status: "UNKNOWN" }).verdict,
    "UNKNOWN",
  );
  assert.equal(
    matchPayment(intent, { ...evidence, timestamp: null }).verdict,
    "UNKNOWN",
  );
  assert.equal(
    matchPayment(intent, {
      ...evidence,
      balanceChanges: [
        { address: intent.recipient, coinType: intent.coinType, amount: "NaN" },
      ],
    }).verdict,
    "UNKNOWN",
  );
});
