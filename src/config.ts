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
  MERCHANT_FIXTURE_LOGIN_ENABLED: z.enum(["true", "false"]).default("false"),
  PRIVY_APP_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/)
    .optional(),
  PRIVY_VERIFICATION_KEY: z.string().min(1).optional(),
  PRIVY_APP_SECRET: z.string().min(1).optional(),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = schema.parse(env);
  if (
    config.PRIVY_VERIFICATION_KEY &&
    !config.PRIVY_VERIFICATION_KEY.includes("-----BEGIN PUBLIC KEY-----")
  )
    throw new Error("PRIVY_VERIFICATION_KEY_MUST_BE_PUBLIC_KEY");
  if (
    Boolean(config.PRIVY_APP_ID) !==
    Boolean(config.PRIVY_APP_SECRET || config.PRIVY_VERIFICATION_KEY)
  )
    throw new Error("PRIVY_APP_ID_AND_SERVER_VERIFICATION_REQUIRED_TOGETHER");
  if (
    config.MERCHANT_FIXTURE_LOGIN_ENABLED === "true" &&
    env.NODE_ENV === "production"
  )
    throw new Error("FIXTURE_LOGIN_FORBIDDEN_IN_PRODUCTION");
  return config;
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
