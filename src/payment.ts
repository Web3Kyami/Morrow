import { z } from "zod";
import { normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/)
  .transform((value) => normalizeSuiAddress(value));
const coin = z.string().transform((value, ctx) => {
  try {
    return normalizeStructTag(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid coin type" });
    return z.NEVER;
  }
});
export const digestSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,50}$/);
export const paymentIntentSchema = z
  .object({
    network: z.literal("testnet"),
    expectedDigest: digestSchema,
    sender: address,
    recipient: address,
    coinType: coin,
    amount: z.string().regex(/^[1-9][0-9]{0,19}$/),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type PaymentIntent = z.input<typeof paymentIntentSchema>;
export const paymentEvidenceSchema = z
  .object({
    provider: z.literal("tatum"),
    method: z.literal("sui.rpc.v2.LedgerService/GetTransaction"),
    network: z.literal("testnet"),
    digest: digestSchema,
    status: z.enum(["SUCCESS", "FAILED", "UNKNOWN"]),
    checkpoint: z.string().regex(/^\d+$/).nullable(),
    sender: address.nullable(),
    timestamp: z.iso.datetime().nullable(),
    checkedAt: z.iso.datetime(),
    balanceChanges: z
      .array(
        z.object({
          address,
          coinType: coin,
          amount: z.string().regex(/^-?[0-9]+$/),
        }),
      )
      .max(1000),
  })
  .strict();
export type PaymentEvidence = z.input<typeof paymentEvidenceSchema>;
export type PaymentMatch = {
  verdict: "MATCH" | "MISMATCH" | "UNKNOWN";
  reason: string;
};
export interface PaymentGateway {
  getTransaction(digest: string): Promise<PaymentEvidence>;
  close?(): void;
}

/** No model or recalled lesson participates in this decision. */
export function matchPayment(
  intent: PaymentIntent,
  evidence: PaymentEvidence,
): PaymentMatch {
  const parsedIntent = paymentIntentSchema.safeParse(intent);
  const parsedEvidence = paymentEvidenceSchema.safeParse(evidence);
  if (!parsedIntent.success || !parsedEvidence.success)
    return { verdict: "UNKNOWN", reason: "INVALID_EVIDENCE" };
  const i = parsedIntent.data,
    e = parsedEvidence.data;
  if (e.status === "UNKNOWN" || !e.checkpoint || !e.timestamp || !e.sender)
    return { verdict: "UNKNOWN", reason: "INCOMPLETE_EVIDENCE" };
  if (e.status !== "SUCCESS")
    return { verdict: "MISMATCH", reason: "FAILED_TRANSACTION" };
  if (
    i.network !== e.network ||
    i.expectedDigest !== e.digest ||
    i.sender !== e.sender
  )
    return { verdict: "MISMATCH", reason: "ORDER_BINDING" };
  const time = Date.parse(e.timestamp);
  if (Date.parse(i.createdAt) >= time || time > Date.parse(i.expiresAt))
    return { verdict: "MISMATCH", reason: "INTENT_TIME_WINDOW" };
  if (
    i.sender === i.recipient ||
    i.coinType !== normalizeStructTag("0x2::sui::SUI")
  )
    return { verdict: "UNKNOWN", reason: "UNSUPPORTED_INTENT" };
  const changes = e.balanceChanges.filter(
    (c) => c.address === i.recipient && c.coinType === i.coinType,
  );
  if (changes.length !== 1 || changes[0]?.amount !== i.amount)
    return { verdict: "MISMATCH", reason: "RECIPIENT_ASSET_AMOUNT" };
  return { verdict: "MATCH", reason: "PRECOMMITTED_PAYMENT_CONFIRMED" };
}
