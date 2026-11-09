import assert from "node:assert/strict";
import test from "node:test";
import {
  mistToSui,
  demoAmountForOffset,
  DEMO_BASE_AMOUNT,
} from "../src/demo-provisioning.js";

test("MIST to SUI conversion is exact, no floating point", () => {
  assert.equal(mistToSui("1000000"), "0.001");
  assert.equal(mistToSui("1000000000"), "1");
  assert.equal(mistToSui("1500000000"), "1.5");
  assert.equal(mistToSui("1000500"), "0.0010005");
  assert.equal(mistToSui("1"), "0.000000001");
  assert.equal(mistToSui("1099999"), "0.001099999");
});

test("per-run amounts are distinct for distinct offsets", () => {
  const a = demoAmountForOffset(1n);
  const b = demoAmountForOffset(2n);
  assert.notEqual(a, b);
  assert.equal(a - DEMO_BASE_AMOUNT, 1n);
  assert.equal(mistToSui(a.toString()), "0.001000001");
});
