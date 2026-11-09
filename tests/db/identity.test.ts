import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import test from "node:test";
import { createPool } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { MerchantService } from "../../src/merchant.js";
import { seedMerchantCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;

function signPrivyTestToken(
  privateKey: KeyObject,
  claims: {
    appId: string;
    userId: string;
    issuer?: string;
    expiration?: number;
  },
) {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: claims.issuer ?? "privy.io",
      aud: claims.appId,
      iat: Math.floor(Date.now() / 1000),
      exp: claims.expiration ?? Math.floor(Date.now() / 1000) + 3600,
      sid: "privy-session-test",
      sub: claims.userId,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

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
      const privyUnavailable = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/privy",
        headers: { authorization: "Bearer header.payload.signature" },
      });
      assert.equal(privyUnavailable.statusCode, 503);
      assert.equal(
        privyUnavailable.json().error,
        "IDENTITY_PROVIDER_UNAVAILABLE",
      );

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

test(
  "Privy identity exchange uses a verified server-side tenant mapping and preserves local fixture isolation",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const merchantFixture = await seedMerchantCase(admin);
    const otherFixture = await seedMerchantCase(admin);
    const appId = "morrow_test_app";
    const userId = `did:privy:${randomBytes(16).toString("hex")}`;
    const subjectHash = createHash("sha256")
      .update("morrow:privy-user:v1\0")
      .update(appId)
      .update("\0")
      .update(userId)
      .digest("hex");
    await admin.query(
      `INSERT INTO morrow.merchant_privy_identities(app_id,subject_hash,tenant_id,operator_id)
       VALUES ($1,$2,$3,$4)`,
      [
        appId,
        subjectHash,
        merchantFixture.actor.tenantId,
        merchantFixture.actor.operatorId,
      ],
    );

    const appKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const attackerKeys = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const token = signPrivyTestToken(appKeys.privateKey, {
      appId,
      userId,
    });
    const invalidSignatureToken = signPrivyTestToken(attackerKeys.privateKey, {
      appId,
      userId,
    });
    const wrongIssuerToken = signPrivyTestToken(appKeys.privateKey, {
      appId,
      userId,
      issuer: "untrusted.example",
    });
    const wrongAudienceToken = signPrivyTestToken(appKeys.privateKey, {
      appId: "another_privy_app",
      userId,
    });
    const expiredToken = signPrivyTestToken(appKeys.privateKey, {
      appId,
      userId,
      expiration: 1,
    });
    const service = new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("UNUSED");
      },
    });
    const app = createApp(
      db,
      service,
      {
        demoEnabled: false,
        fixtureLoginEnabled: false,
        privyAppId: appId,
      },
      undefined as never,
      new MerchantService(db, {
        appId,
        verificationKey: appKeys.publicKey.export({
          type: "spki",
          format: "pem",
        }) as string,
      }),
    );
    try {
      const authConfig = await app.inject({
        url: "/api/v1/merchant/auth/config",
      });
      assert.deepEqual(authConfig.json(), {
        privy: { enabled: true, appId },
        fixtureLoginEnabled: false,
      });
      await assert.rejects(
        db.query(
          "SELECT subject_hash FROM morrow.merchant_privy_identities LIMIT 1",
        ),
        (error: { code?: string }) => error.code === "42501",
        "runtime role cannot enumerate Privy identity links",
      );

      const fixtureLogin = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session",
        payload: {
          email: "fixture@example.test",
          password: "fixture-password",
        },
      });
      assert.equal(fixtureLogin.statusCode, 503);
      assert.equal(fixtureLogin.json().error, "FIXTURE_LOGIN_DISABLED");

      const malformed = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/privy",
        headers: { authorization: "Bearer not-a-jwt" },
      });
      assert.equal(malformed.statusCode, 401);

      const invalidSignature = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/privy",
        headers: { authorization: `Bearer ${invalidSignatureToken}` },
      });
      assert.equal(invalidSignature.statusCode, 401);

      const wrongIssuer = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/privy",
        headers: { authorization: `Bearer ${wrongIssuerToken}` },
      });
      assert.equal(wrongIssuer.statusCode, 401);

      const wrongAudience = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/privy",
        headers: { authorization: `Bearer ${wrongAudienceToken}` },
      });
      assert.equal(wrongAudience.statusCode, 401);

      const expired = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/privy",
        headers: { authorization: `Bearer ${expiredToken}` },
      });
      assert.equal(expired.statusCode, 401);

      const login = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/privy",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(login.statusCode, 200);
      const setCookie = String(login.headers["set-cookie"] ?? "");
      assert.match(setCookie, /morrow_merchant_session=/);
      assert.match(setCookie, /HttpOnly/);
      const cookie = setCookie.match(/morrow_merchant_session=([^;]+)/)?.[1];
      assert.ok(cookie);

      const queue = await app.inject({
        url: "/api/v1/merchant/cases",
        headers: { cookie: `morrow_merchant_session=${cookie}` },
      });
      assert.equal(queue.statusCode, 200);
      assert.deepEqual(
        queue.json().cases.map((row: { caseId: string }) => row.caseId),
        [merchantFixture.caseId],
        "the verified Privy subject receives only its mapped tenant",
      );
      assert.notEqual(
        merchantFixture.actor.tenantId,
        otherFixture.actor.tenantId,
      );

      const attemptedSpoof = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/privy",
        headers: { authorization: `Bearer ${token}` },
        payload: { tenantId: otherFixture.actor.tenantId, role: "merchant" },
      });
      assert.equal(attemptedSpoof.statusCode, 400);

      const noLinkService = new MerchantService(db, {
        appId,
        verificationKey: appKeys.publicKey.export({
          type: "spki",
          format: "pem",
        }) as string,
      });
      const unlinkedToken = signPrivyTestToken(appKeys.privateKey, {
        appId,
        userId: `did:privy:${randomBytes(16).toString("hex")}`,
      });
      const noLinkApp = createApp(
        db,
        service,
        { demoEnabled: false, privyAppId: appId },
        undefined as never,
        noLinkService,
      );
      try {
        const unlinked = await noLinkApp.inject({
          method: "POST",
          url: "/api/v1/merchant/session/privy",
          headers: { authorization: `Bearer ${unlinkedToken}` },
        });
        assert.equal(unlinked.statusCode, 401);
        assert.equal(unlinked.headers["set-cookie"], undefined);
      } finally {
        await noLinkApp.close();
      }

      await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/logout",
        headers: { cookie: `morrow_merchant_session=${cookie}` },
      });
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);
