import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("browser API preserves JSON content type with bearer headers", async () => {
  let sent: RequestInit | undefined;
  const context = vm.createContext({
    window: {},
    fetch: async (_path: string, options: RequestInit) => {
      sent = options;
      return { ok: true, text: async () => "{}" };
    },
  });
  vm.runInContext(await readFile("web/app.js", "utf8"), context);
  await context.window.Morrow.api("/api/v1/example", {
    method: "POST",
    headers: { authorization: "Bearer fictional" },
    body: "{}",
  });
  assert.equal(
    (sent?.headers as Record<string, string>)["content-type"],
    "application/json",
  );
  assert.equal(
    (sent?.headers as Record<string, string>).authorization,
    "Bearer fictional",
  );
});

test("bodyless browser actions do not declare an empty JSON body", async () => {
  let sent: RequestInit | undefined;
  const context = vm.createContext({
    window: {},
    fetch: async (_path: string, options: RequestInit) => {
      sent = options;
      return { ok: true, text: async () => "{}" };
    },
  });
  vm.runInContext(await readFile("web/app.js", "utf8"), context);
  await context.window.Morrow.api("/api/v1/example", { method: "POST" });
  assert.equal(
    (sent?.headers as Record<string, string>)["content-type"],
    undefined,
    "Fastify rejects a bodyless POST declared as JSON",
  );
});

test("case ID validation accepts ordinary UUIDs and refuses malformed paths", async () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(await readFile("web/app.js", "utf8"), context);
  assert.equal(
    context.window.Morrow.validCaseId("574ad587-bad9-4cad-a079-beffc4424f72"),
    true,
  );
  assert.equal(context.window.Morrow.validCaseId("a".repeat(36)), false);
  assert.equal(context.window.Morrow.validCaseId("../../private"), false);
});

test("proof uses the active run capability and reports each persisted outcome", async () => {
  const ids = [
    "proof-loading",
    "proof-content",
    "proof-empty",
    "proof-actions",
    "proof-error",
    "retry-proof",
    "proof-a-detail",
    "proof-a-state",
    "proof-memory-detail",
    "proof-memory-state",
    "proof-memory-blob-row",
    "proof-memory-blob",
    "proof-b-detail",
    "proof-b-state",
    "proof-c-detail",
    "proof-c-state",
    "mainnet-deferred",
    "main",
    "reset-demo",
    "exit-demo",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        value: "",
        textContent: "",
        className: "",
        hidden: false,
        disabled: false,
        dataset: {},
        addEventListener: () => {},
      },
    ]),
  ) as Record<string, any>;
  const calls: Array<{ path: string; headers?: Record<string, string> }> = [];
  const context = vm.createContext({
    window: {
      Morrow: {
        el: (id: string) => elements[id],
        friendlyError: () => "unexpected error",
        busy: async (_button: unknown, action: () => Promise<void>) => action(),
        api: async (
          path: string,
          options?: { headers?: Record<string, string> },
        ) => {
          calls.push({
            path,
            ...(options?.headers ? { headers: options.headers } : {}),
          });
          return {
            a: {
              status: "PASS",
              payment: { verdict: "MATCH" },
              entitlement: { after: "RESTORED" },
              lesson: {
                state: "RECALL_VERIFIED",
                blobId: "real-test-blob",
                network: "testnet",
                recalledAt: "2026-11-10T00:00:00.000Z",
              },
            },
            b: { state: "COMPLETE", outcome: "GUIDANCE_DIFFERENCE" },
            c: {
              status: "PASS",
              payment: {
                verdict: "MISMATCH",
                successfulTransaction: true,
                observedAmountMist: "1000000",
                expectedAmountMist: "1000001",
              },
              entitlement: { after: "MISSING" },
              repairs: 0,
            },
            mainnet: { status: "DEFERRED", memories: 0, required: 10 },
          };
        },
      },
    },
    sessionStorage: {
      getItem: () =>
        JSON.stringify({ token: "opaque-session-token", key: "opaque-key" }),
      removeItem: () => {},
    },
    location: { href: "" },
  });
  vm.runInContext(await readFile("web/proof.js", "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/api/v1/demo/proof"],
  );
  assert.equal(calls[0]?.headers?.authorization, "Bearer opaque-session-token");
  assert.equal(calls[0]?.headers?.["idempotency-key"], "opaque-key");
  assert.match(
    elements["proof-c-detail"].textContent,
    /1000000 MIST; expected 1000001 MIST/,
  );
  assert.match(elements["proof-c-state"].textContent, /Mismatch refused/);
  assert.match(
    elements["proof-memory-state"].textContent,
    /Fresh recall verified/,
  );
  assert.equal(elements["proof-memory-blob"].textContent, "real-test-blob");
  assert.equal(elements["proof-memory-blob-row"].hidden, false);
  assert.match(
    elements["proof-b-detail"].textContent,
    /does not prove a faster or better outcome/,
  );
  assert.match(elements["mainnet-deferred"].textContent, /0 of 10/);
  assert.equal(elements["proof-content"].hidden, false);

  const markup = await readFile("web/proof.html", "utf8");
  assert.doesNotMatch(markup, /id="(?:case-a|case-b|case-c|demo-token)"/);
});
