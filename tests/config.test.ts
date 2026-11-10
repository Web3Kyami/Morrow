import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";

const database = "postgres://morrow.example.invalid/database";

test("merchant identity requires an app credential or public key and stays production safe", () => {
  const defaults = readConfig({ DATABASE_URL: database });
  assert.equal(defaults.MERCHANT_FIXTURE_LOGIN_ENABLED, "false");
  assert.equal(defaults.PRIVY_APP_ID, undefined);
  assert.equal(defaults.PRIVY_VERIFICATION_KEY, undefined);

  assert.equal(
    readConfig({
      DATABASE_URL: database,
      PRIVY_APP_ID: "morrow_app_id",
      PRIVY_APP_SECRET: "server-only-app-secret",
    }).PRIVY_APP_ID,
    "morrow_app_id",
  );
  assert.throws(
    () =>
      readConfig({
        DATABASE_URL: database,
        PRIVY_APP_ID: "morrow_app_id",
        PRIVY_VERIFICATION_KEY: "server-only-app-secret",
      }),
    /PRIVY_VERIFICATION_KEY_MUST_BE_PUBLIC_KEY/,
  );

  assert.throws(
    () =>
      readConfig({
        DATABASE_URL: database,
        PRIVY_APP_ID: "morrow_app_id",
      }),
    /PRIVY_APP_ID_AND_SERVER_VERIFICATION_REQUIRED_TOGETHER/,
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
