import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "../src/database.js";
import { createApp } from "../src/http.js";
import { ResolutionService } from "../src/resolution.js";

test("split login assets with URL-safe hashes load without exposing private files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morrow-assets-"));
  const db = createPool("postgres://unused:unused@127.0.0.1:1/unused");
  const app = createApp(
    db,
    new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("Static assets must not call payment providers");
      },
    }),
    { demoEnabled: false, staticDir: directory, privyAppId: "morrow_app_id" },
  );
  try {
    await writeFile(
      join(directory, "privy-test_hash.js"),
      "export const ready = true;",
    );
    await writeFile(join(directory, ".env"), "PRIVATE=true");
    await writeFile(join(directory, "merchant-login.html"), "<h1>Sign in</h1>");
    const asset = await app.inject({ url: "/assets/privy-test_hash.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers["content-type"]), /javascript/);
    assert.equal(asset.body, "export const ready = true;");
    assert.equal((await app.inject({ url: "/assets/.env" })).statusCode, 404);
    assert.equal(
      (await app.inject({ url: "/CURRENT_STATE.md" })).statusCode,
      404,
    );
    const login = await app.inject({ url: "/merchant/login" });
    const afterLogout = await app.inject({
      url: "/merchant/login?signedOut=1",
    });
    assert.equal(
      afterLogout.headers["content-security-policy"],
      login.headers["content-security-policy"],
      "sign-out and login must allow the same identity provider resources",
    );
  } finally {
    await app.close();
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
});
