import { existsSync, statSync } from "node:fs";
const phases: Record<string, string[]> = {
  database: ["DATABASE_URL", "DIRECT_URL"],
  payment: [
    "TATUM_API_KEY",
    "DEMO_SUI_PAYER_ADDRESS",
    "DEMO_SUI_RECIPIENT_ADDRESS",
    "SUI_SIGNER_REF",
  ],
  memory: [
    "MEMWAL_NETWORK",
    "MEMWAL_ACCOUNT_ID",
    "MEMWAL_PRIVATE_KEY",
    "MEMWAL_NAMESPACE",
  ],
  agent: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"],
};
for (const [phase, names] of Object.entries(phases))
  for (const name of names)
    console.log(
      `${phase}: ${name}: ${process.env[name] ? "PRESENT_UNTESTED" : "MISSING"}`,
    );
if (existsSync(".env"))
  console.log(
    `.env permissions: ${(statSync(".env").mode & 0o777).toString(8)}`,
  );
