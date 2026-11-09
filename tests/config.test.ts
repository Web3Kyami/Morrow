import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";

const database = "postgres://morrow.example.invalid/database";

test("merchant identity configuration is all-or-nothing and production safe", () => {
  const defaults = readConfig({ DATABASE_URL: database });
  assert.equal(defaults.MERCHANT_FIXTURE_LOGIN_ENABLED, "false");
  assert.equal(defaults.PRIVY_APP_ID, undefined);
  assert.equal(defaults.PRIVY_VERIFICATION_KEY, undefined);

  assert.throws(
    () =>
      readConfig({
        DATABASE_URL: database,
        PRIVY_APP_ID: "morrow_app_id",
      }),
    /PRIVY_APP_ID_AND_VERIFICATION_KEY_REQUIRED_TOGETHER/,
  );
  assert.throws(
    () =>
      readConfig({
        DATABASE_URL: database,
        NODE_ENV: "production",
        MERCHANT_FIXTURE_LOGIN_ENABLED: "true",
      }),
    /FIXTURE_LOGIN_FORBIDDEN_IN_PRODUCTION/,
  );
  assert.equal(
    readConfig({
      DATABASE_URL: database,
      NODE_ENV: "test",
      MERCHANT_FIXTURE_LOGIN_ENABLED: "true",
    }).MERCHANT_FIXTURE_LOGIN_ENABLED,
    "true",
  );
});
