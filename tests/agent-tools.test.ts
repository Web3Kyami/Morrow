import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterPlanner } from "../src/agent.js";
const caseId = "11111111-1111-4111-8111-111111111111",
  id = "22222222-2222-4222-8222-222222222222";
const context = {
  caseId,
  policyVersion: 1,
  evidence: [
    { id, kind: "payment_check", facts: { verdict: "MATCH", entitled: false } },
  ],
  lessons: [],
};
test("model executes a scoped read tool before a validated proposal; never accepts foreign evidence", async () => {
  let n = 0;
  const requests: Record<string, unknown>[] = [];
  const fake = async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    n++;
    return new Response(
      JSON.stringify({
        model: "fixture:free",
        usage: { total_tokens: 42, cost: 0 },
        choices: [
          {
            message:
              n === 1
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "read_case",
                          arguments: JSON.stringify({ caseId }),
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: JSON.stringify({
                      action: "REQUEST_MERCHANT_REVIEW",
                      reason: "Payment matches; approval required.",
                      evidenceIds: [id],
                      uncertainty: "low",
                    }),
                  },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const result = await new OpenRouterPlanner(
    "fixture-key",
    "fixture:free",
    fake as typeof fetch,
  ).investigate(context);
  assert.equal(n, 2);
  assert.equal(result.action, "REQUEST_MERCHANT_REVIEW");
  assert.equal(result.execution?.tools[0], "read_case");
  const messages = requests[1]!.messages as Array<{
    role: string;
    content: string;
  }>;
  assert.ok(messages.some((m) => m.role === "tool" && m.content.includes(id)));
});
test("unknown or cross-case tool calls fail before a second request", async () => {
  let requests = 0;
  const fake = async () => {
    requests++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "x",
                  type: "function",
                  function: {
                    name: "read_case",
                    arguments: JSON.stringify({
                      caseId: "33333333-3333-4333-8333-333333333333",
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  };
  await assert.rejects(() =>
    new OpenRouterPlanner(
      "fixture-key",
      "fixture:free",
      fake as typeof fetch,
    ).investigate(context),
  );
  assert.equal(requests, 1);
});
test("foreign evidence and unsafe UNKNOWN proposals fail closed; paid models never send a request", async () => {
  for (const unsafe of ["FOREIGN", "UNKNOWN"] as const) {
    let round = 0;
    const fake = async () =>
      new Response(
        JSON.stringify({
          usage: { cost: 0, total_tokens: 20 },
          choices: [
            {
              message:
                ++round === 1
                  ? {
                      tool_calls: [
                        {
                          id: "read",
                          type: "function",
                          function: {
                            name: "read_case",
                            arguments: JSON.stringify({ caseId }),
                          },
                        },
                      ],
                    }
                  : {
                      content: JSON.stringify({
                        action:
                          unsafe === "UNKNOWN"
                            ? "REFUSE"
                            : "REQUEST_MERCHANT_REVIEW",
                        reason: "Untrusted reply",
                        evidenceIds: [
                          unsafe === "FOREIGN"
                            ? "33333333-3333-4333-8333-333333333333"
                            : id,
                        ],
                        uncertainty: "low",
                      }),
                    },
            },
          ],
        }),
      );
    await assert.rejects(
      () =>
        new OpenRouterPlanner(
          "fixture",
          "fixture:free",
          fake as typeof fetch,
        ).investigate({
          ...context,
          evidence: [
            {
              id,
              kind: "payment_check",
              facts: {
                verdict: unsafe === "UNKNOWN" ? "UNKNOWN" : "MATCH",
                entitled: false,
              },
            },
          ],
        }),
      new RegExp(
        unsafe === "FOREIGN"
          ? "AGENT_UNKNOWN_EVIDENCE"
          : "AGENT_UNSAFE_PROPOSAL",
      ),
    );
    assert.equal(round, 2);
  }
  let called = false;
  await assert.rejects(
    () =>
      new OpenRouterPlanner("fixture", "paid/model", (async () => {
        called = true;
        throw Error("unexpected");
      }) as typeof fetch).investigate(context),
    /FREE_MODEL_REQUIRED/,
  );
  assert.equal(called, false);
});
