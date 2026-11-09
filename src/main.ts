import { configuredPlanner } from "./agent.js";
import { DemoJourneyService } from "./demo-journey.js";
import { readConfig } from "./config.js";
import { createPool, assertRuntimeRole, type Database } from "./database.js";
import { createApp } from "./http.js";
import { CustomerService } from "./customer.js";
import { FairComparisonService } from "./fair.js";
import {
  DemoProvisioningService,
  buildTatumDemoIntent,
} from "./demo-provisioning.js";
import { MerchantService } from "./merchant.js";
import { merchantLessonsFor, tenantMemoryFor } from "./lesson-factory.js";
import { buildInvestigationService } from "./investigation.js";
import { ResolutionService } from "./resolution.js";
import { merchantProviderStatus } from "./provider-status.js";
import { tatumGateway } from "./providers/tatum.js";
import type { PaymentGateway } from "./payment.js";

let pool: Database | undefined;
try {
  const config = readConfig();
  pool = createPool(config.DATABASE_URL);
  await assertRuntimeRole(pool);
  // Absent credentials produce UNKNOWN through the service, never fictional payment success.
  const payment: PaymentGateway = config.TATUM_API_KEY
    ? tatumGateway(config.TATUM_API_KEY)
    : {
        getTransaction: async () => {
          throw new Error("PAYMENT_PROVIDER_NOT_CONFIGURED");
        },
      };
  const resolution = new ResolutionService(pool, payment);
  const merchant = new MerchantService(
    pool,
    config.PRIVY_APP_ID && config.PRIVY_VERIFICATION_KEY
      ? {
          appId: config.PRIVY_APP_ID,
          verificationKey: config.PRIVY_VERIFICATION_KEY,
        }
      : undefined,
  );
  const provisioning = new DemoProvisioningService(
    pool,
    () =>
      buildTatumDemoIntent({
        TATUM_API_KEY: config.TATUM_API_KEY,
        DEMO_SUI_PAYER_ADDRESS: config.DEMO_SUI_PAYER_ADDRESS,
        DEMO_SUI_RECIPIENT_ADDRESS: config.DEMO_SUI_RECIPIENT_ADDRESS,
        SUI_PAYMENT_NETWORK: config.SUI_PAYMENT_NETWORK,
      }),
    { deferPayments: true },
  );
  const investigation = buildInvestigationService(pool, resolution);
  const fair = new FairComparisonService(
    pool,
    resolution,
    tenantMemoryFor,
    configuredPlanner(),
  );
  const app = createApp(
    pool,
    resolution,
    {
      demoEnabled: config.DEMO_ENABLED === "true",
      secureCookies: config.SESSION_COOKIE_SECURE === "true",
      fixtureLoginEnabled: config.MERCHANT_FIXTURE_LOGIN_ENABLED === "true",
      privyAppId: config.PRIVY_APP_ID ?? null,
      staticDir: new URL("../web/", import.meta.url).pathname,
      merchantLessons: (p, tenantId) => merchantLessonsFor(p, tenantId),
      providerStatus: (actor) => merchantProviderStatus(pool!, actor),
      demoJourney: new DemoJourneyService(
        pool!,
        resolution,
        provisioning,
        investigation,
        tenantMemoryFor,
        fair,
      ),
    },
    new CustomerService(pool),
    merchant,
    investigation,
    fair,
    provisioning,
  );
  app.addHook("onClose", async () => {
    payment.close?.();
    await pool!.end();
  });
  await app.listen({ host: config.HOST, port: config.PORT });
  console.log(`Morrow API listening on port ${config.PORT}`);
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch {
  await pool?.end();
  console.error("Morrow startup failed: check private server configuration");
  process.exitCode = 1;
}
