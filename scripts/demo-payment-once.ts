import { createPool, assertRuntimeRole } from "../src/database.js";
import { DemoPaymentWorker } from "../src/demo-payment-worker.js";
import { ResolutionService } from "../src/resolution.js";
import { tatumGateway } from "../src/providers/tatum.js";
import { createDemoChain } from "./demo-chain.js";
const db = createPool(process.env.DATABASE_URL!);
let chain: Awaited<ReturnType<typeof createDemoChain>> | undefined;
const gateway = tatumGateway(process.env.TATUM_API_KEY!);
try {
  await assertRuntimeRole(db);
  const result = await new DemoPaymentWorker(
    db,
    async () => {
      chain = await createDemoChain();
      return chain.chain;
    },
    new ResolutionService(db, gateway),
  ).runOne();
  if (result) console.log("Testnet demo payment:", result);
} catch {
  console.error(
    "Demo payment worker unavailable; no replacement transaction constructed",
  );
  process.exitCode = 1;
} finally {
  chain?.close();
  gateway.close?.();
  await db.end();
}
