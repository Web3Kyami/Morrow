import { MemWal } from "@mysten-incubation/memwal";
import { memoryConfigSchema, type MemoryConfig } from "../config.js";
import type { MemoryGateway } from "../memory.js";

export function walrusGateway(input: MemoryConfig): MemoryGateway {
  const config = memoryConfigSchema.parse(input);
  const client = MemWal.create({
    key: config.key,
    accountId: config.accountId,
    namespace: config.namespace,
    serverUrl:
      config.network === "testnet"
        ? "https://relayer.dev.memwal.ai"
        : "https://relayer.memory.walrus.xyz",
    requestTimeoutMs: 15_000,
    recallTimeoutMs: 15_000,
    preflightTimeoutMs: 5_000,
  });
  return {
    async remember(text, idempotencyKey) {
      // Foundation never initiates Mainnet writes. Promotion is a separately authorized phase.
      if (config.network === "mainnet")
        throw new Error("MAINNET_WRITE_REQUIRES_OWNER_ACTION");
      const accepted = await client.remember(text, {
        idempotencyKey,
        dedupe: true,
      });
      if (!accepted.job_id) throw new Error("MEMORY_JOB_ID_MISSING");
      return { jobId: accepted.job_id };
    },
    async status(jobId) {
      return client.getRememberStatus(jobId);
    },
    async recall(query) {
      const result = await client.recall({
        query,
        namespace: config.namespace,
        limit: 100,
      });
      return result.results.map((r) => ({ blobId: r.blob_id, text: r.text }));
    },
    close() {
      client.destroy();
    },
  };
}
