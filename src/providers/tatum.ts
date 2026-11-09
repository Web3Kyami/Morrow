import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";
import {
  digestSchema,
  paymentEvidenceSchema,
  type PaymentGateway,
} from "../payment.js";

/** Fixed Testnet endpoint prevents configuration from sending a credential to another host. */
export function tatumClient(key: string) {
  const transport = new GrpcTransport({
    host: "sui-testnet-grpc.gateway.tatum.io:443",
    channelCredentials: ChannelCredentials.createSsl(),
    meta: { "x-api-key": key },
    timeout: 10_000,
  });
  return {
    client: new SuiGrpcClient({ network: "testnet", transport }),
    close: () => transport.close(),
  };
}

export function tatumGateway(key: string): PaymentGateway {
  const { client, close } = tatumClient(key);
  return {
    close,
    async getTransaction(digest) {
      digestSchema.parse(digest);
      const { response } = await client.ledgerService.getTransaction(
        {
          digest,
          readMask: {
            paths: [
              "digest",
              "transaction.sender",
              "effects.status",
              "checkpoint",
              "timestamp",
              "balance_changes",
            ],
          },
        },
        { meta: { "x-api-key": key }, timeout: 10_000 },
      );
      const tx = response.transaction;
      if (!tx) throw new Error("TATUM_TRANSACTION_UNAVAILABLE");
      const timestamp = tx.timestamp
        ? new Date(
            Number(tx.timestamp.seconds) * 1000 +
              Math.floor(tx.timestamp.nanos / 1e6),
          ).toISOString()
        : null;
      return paymentEvidenceSchema.parse({
        provider: "tatum",
        method: "sui.rpc.v2.LedgerService/GetTransaction",
        network: "testnet",
        digest: tx.digest,
        sender: tx.transaction?.sender ?? null,
        status:
          tx.effects?.status?.success === true
            ? "SUCCESS"
            : tx.effects?.status?.success === false
              ? "FAILED"
              : "UNKNOWN",
        checkpoint: tx.checkpoint?.toString() ?? null,
        timestamp,
        checkedAt: new Date().toISOString(),
        balanceChanges: tx.balanceChanges.map((c) => ({
          address: c.address,
          coinType: c.coinType,
          amount: c.amount,
        })),
      });
    },
  };
}
