import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../../src/database.js";
import { merchantProviderStatus } from "../../src/provider-status.js";
import { seedMerchantCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;

test(
  "merchant provider status is read-only, tenant-scoped and does not expose credentials",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      runtime = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const first = await seedMerchantCase(admin),
      second = await seedMerchantCase(admin);
    try {
      const status = await merchantProviderStatus(runtime, first.actor, {});
      assert.equal(status.database.state, "CONNECTED");
      assert.equal(status.tatum.state, "NOT_CONFIGURED");
      assert.equal(status.walrus.state, "NOT_CONFIGURED");
      assert.equal(status.walrus.latestLesson, null);
      assert.equal("key" in status.walrus, false);
      assert.equal("accountId" in status.walrus, false);

      const isolated = await merchantProviderStatus(runtime, second.actor, {});
      assert.equal(isolated.walrus.latestLesson, null);
      assert.deepEqual(isolated.walrus.lessonCounts, {});
      assert.match(status.note, /no live storage probe/i);
    } finally {
      await admin.end();
      await runtime.end();
    }
  },
);
