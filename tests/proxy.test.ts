import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../src/database.js";
import { createApp } from "../src/http.js";
import { CustomerService } from "../src/customer.js";
import { ResolutionService } from "../src/resolution.js";

test("loopback proxy preserves separate visitor budgets and direct clients cannot spoof their IP", async () => {
  const db = createPool("postgres://unused:unused@127.0.0.1:1/unused");
  const app = createApp(
    db,
    new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("No provider call expected");
      },
    }),
    { demoEnabled: true },
    new CustomerService(db),
  );
  const attempt = (remoteAddress: string, forwarded: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/help-requests",
      remoteAddress,
      headers: { "x-forwarded-for": forwarded },
      payload: {},
    });
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await attempt("127.0.0.1", "198.51.100.1")).statusCode,
        400,
      );
    assert.equal((await attempt("127.0.0.1", "198.51.100.1")).statusCode, 429);
    assert.equal((await attempt("127.0.0.1", "198.51.100.2")).statusCode, 400);
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await attempt("198.51.100.3", `203.0.113.${i + 1}`)).statusCode,
        400,
      );
    assert.equal(
      (await attempt("198.51.100.3", "203.0.113.99")).statusCode,
      429,
    );
  } finally {
    await app.close();
    await db.end();
  }
});
