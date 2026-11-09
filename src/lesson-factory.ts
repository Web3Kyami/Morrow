import type { Database } from "./database.js";
import { memoryConfig, type MemoryConfig } from "./config.js";
import { LessonService } from "./lessons.js";
import type { MemoryGateway } from "./memory.js";
import { walrusGateway } from "./providers/walrus.js";

export type MerchantLessons = {
  service: LessonService;
  tenantConfig: MemoryConfig;
  close: () => void;
} | null;

/**
 * S8 seam: per-tenant LessonService with the TENANT-scoped namespace
 * (morrow-testnet:<tenantId>). LessonService refuses any namespace
 * without the tenant suffix, so a cross-tenant lesson can never be
 * written. Returns null when memory is unconfigured (honest disabled).
 */
export function merchantLessonsFor(
  pool: Database,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): MerchantLessons {
  let base: MemoryConfig;
  try {
    base = memoryConfig(env);
  } catch {
    return null;
  }
  if (base.network !== "testnet") return null;
  const tenantConfig: MemoryConfig = {
    ...base,
    namespace: `morrow-testnet:${tenantId}`,
  };
  const gateway = walrusGateway(tenantConfig);
  const service = new LessonService(pool, tenantConfig, gateway);
  return { service, tenantConfig, close: () => gateway.close() };
}

export type ScopedMemory = {
  gateway: MemoryGateway;
  tenantConfig: MemoryConfig;
  close: () => void;
};
export function tenantMemoryFor(tenantId: string): ScopedMemory | null {
  let base: MemoryConfig;
  try {
    base = memoryConfig();
  } catch {
    return null;
  }
  if (base.network !== "testnet") return null;
  const tenantConfig = { ...base, namespace: `morrow-testnet:${tenantId}` };
  const gateway = walrusGateway(tenantConfig);
  return { gateway, tenantConfig, close: () => gateway.close() };
}
