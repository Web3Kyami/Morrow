import { Transaction } from "@mysten/sui/transactions";
import type { ReservedIntent } from "./demo-provisioning.js";
/** Reject every command except the fixed native-SUI demo transfer. */
export async function validateDemoTransaction(
  intent: ReservedIntent,
  payer: string,
  recipient: string,
) {
  const bytes = Buffer.from(intent.transactionBytes, "base64");
  const tx = Transaction.from(bytes),
    data = tx.getData();
  if (
    (await tx.getDigest()) !== intent.digest ||
    data.sender !== payer ||
    intent.sender !== payer ||
    intent.recipient !== recipient ||
    payer === recipient
  )
    throw Error("SIGNING_SCOPE_MISMATCH");
  if (
    data.gasData.owner !== payer ||
    !data.gasData.budget ||
    BigInt(data.gasData.budget) > 10_000_000n ||
    data.gasData.budget !== intent.gasBudget
  )
    throw Error("SIGNING_GAS_BUDGET");
  const refs = data.gasData.payment
    ?.map((g) => `${g.objectId}:${g.version}:${g.digest}`)
    .sort();
  if (
    !refs?.length ||
    JSON.stringify(refs) !== JSON.stringify([...intent.gasRefs].sort())
  )
    throw Error("UNRESERVED_GAS");
  const split = data.commands[0],
    transfer = data.commands[1];
  if (
    data.commands.length !== 2 ||
    data.inputs.length !== 2 ||
    split?.$kind !== "SplitCoins" ||
    transfer?.$kind !== "TransferObjects"
  )
    throw Error("SIGNING_COMMAND_REJECTED");
  if (
    split.SplitCoins.coin.$kind !== "GasCoin" ||
    split.SplitCoins.amounts.length !== 1 ||
    split.SplitCoins.amounts[0]?.$kind !== "Input"
  )
    throw Error("SIGNING_AMOUNT_REJECTED");
  const amount = data.inputs[split.SplitCoins.amounts[0].Input];
  if (amount?.$kind !== "Pure") throw Error("SIGNING_AMOUNT_REJECTED");
  const amountBytes = Buffer.from(amount.Pure.bytes, "base64");
  if (
    amountBytes.length !== 8 ||
    amountBytes.readBigUInt64LE() !== BigInt(intent.amount) ||
    BigInt(intent.amount) < 1_000_000n ||
    BigInt(intent.amount) > 1_500_000n
  )
    throw Error("SIGNING_AMOUNT_REJECTED");
  const out = transfer.TransferObjects;
  if (
    out.objects.length !== 1 ||
    out.objects[0]?.$kind !== "NestedResult" ||
    JSON.stringify(out.objects[0].NestedResult) !== "[0,0]" ||
    out.address.$kind !== "Input"
  )
    throw Error("SIGNING_TRANSFER_REJECTED");
  const address = data.inputs[out.address.Input];
  if (
    address?.$kind !== "Pure" ||
    "0x" + Buffer.from(address.Pure.bytes, "base64").toString("hex") !==
      recipient
  )
    throw Error("SIGNING_RECIPIENT_REJECTED");
  return bytes;
}
