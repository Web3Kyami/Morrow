import { z } from "zod";
const schema = z.object({
  DATABASE_URL: z.url(),
  HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3100),
  TATUM_API_KEY: z.string().min(1).optional(),
  DEMO_SUI_PAYER_ADDRESS: z.string().min(1).optional(),
  DEMO_SUI_RECIPIENT_ADDRESS: z.string().min(1).optional(),
  SUI_PAYMENT_NETWORK: z.literal("testnet").default("testnet"),
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  DEMO_ENABLED: z.enum(["true", "false"]).default("false"),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  return schema.parse(env);
}

export const memoryConfigSchema = z
  .object({
    network: z.enum(["testnet", "mainnet"]),
    accountId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    key: z.string().min(1),
    namespace: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[a-zA-Z0-9:_-]+$/),
  })
  .strict();
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
export function memoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): MemoryConfig {
  return memoryConfigSchema.parse({
    network: env.MEMWAL_NETWORK,
    accountId: env.MEMWAL_ACCOUNT_ID,
    key: env.MEMWAL_PRIVATE_KEY,
    namespace: env.MEMWAL_NAMESPACE,
  });
}
