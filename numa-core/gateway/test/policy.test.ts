import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy } from "../src/policy.ts";

test("read-only and safe reversible actions are allowed", () => {
  assert.equal(evaluatePolicy({ permissionLevel: 0, risk: "low", approved: false }).decision, "allow");
  assert.equal(evaluatePolicy({ permissionLevel: 1, risk: "low", approved: false }).decision, "allow");
});

test("confirmation levels require approval", () => {
  assert.equal(evaluatePolicy({ permissionLevel: 2, risk: "low", approved: false }).decision, "approve");
  assert.equal(evaluatePolicy({ permissionLevel: 3, risk: "medium", approved: false }).decision, "approve");
});

test("high risk requires approval even at level 1", () => {
  assert.equal(evaluatePolicy({ permissionLevel: 1, risk: "high", approved: false }).decision, "approve");
});

test("locked capabilities are denied, approval or not", () => {
  assert.equal(evaluatePolicy({ permissionLevel: 4, risk: "low", approved: false }).decision, "deny");
  assert.equal(evaluatePolicy({ permissionLevel: 4, risk: "low", approved: true }).decision, "deny");
});

test("approval turns a confirmation into an allow", () => {
  assert.equal(evaluatePolicy({ permissionLevel: 3, risk: "high", approved: true }).decision, "allow");
});
