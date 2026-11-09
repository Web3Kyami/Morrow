import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { MerchantService } from "../../src/merchant.js";

const url = process.env.TEST_DATABASE_URL;

test(
  "identity handoff: password recovery is explicitly rejected, never faked",
  { skip: !url },
  async () => {
    const db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const app = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("UNUSED");
        },
      }),
      { demoEnabled: true },
      undefined as never,
      new MerchantService(db),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/password-recovery",
        payload: { email: "merchant@example.test" },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error, "IDENTITY_RECOVERY_NOT_CONFIGURED");
      // Unknown email gets the same generic rejection (no enumeration).
      const unknown = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/password-recovery",
        payload: { email: `nobody-${Date.now()}@example.test` },
      });
      assert.equal(unknown.statusCode, 503);
      assert.equal(unknown.json().error, "IDENTITY_RECOVERY_NOT_CONFIGURED");
      // Malformed email is a validation error, not a silent success.
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/password-recovery",
        payload: { email: "not-an-email" },
      });
      assert.notEqual(bad.statusCode, 200);
    } finally {
      await app.close();
      await db.end();
    }
  },
);
