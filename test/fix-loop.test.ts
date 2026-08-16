import { test } from "node:test";
import assert from "node:assert/strict";
import { approve, runStep } from "../src/engine/engine.js";
import { readState } from "../src/engine/state.js";
import { makeRoot, setStep, writeIn, writeStatus, validReview, validResult } from "./helpers.js";

function doFix(root: string, config: any): void {
  writeIn(root, "current-result.md", validResult);
  writeStatus(root, { step: "fix", result: "fixed", reason: "x" });
  const o = runStep(root, config, "fix");
  assert.equal(o.kind, "transitioned");
  assert.equal(o.kind === "transitioned" && o.to, "improve-check");
}

function improveIncomplete(root: string, config: any) {
  writeStatus(root, { step: "improve-check", result: "fix-incomplete", reason: "x" });
  return runStep(root, config, "improve-check");
}

// Test 1 — Fix loop is bounded: fix-required→fix(1)→…→fix(3)→incomplete ⇒ escalation, no 4th fix.
test("1: fix loop halts at escalation after maxRetries+1 entries", () => {
  const { root, config } = makeRoot();
  setStep(root, "review", { fixAttempts: 0 });
  writeIn(root, "current-review.md", validReview);
  writeStatus(root, { step: "review", result: "fix-required", reason: "x" });

  let o = runStep(root, config, "review");
  assert.equal(o.kind, "awaiting-approval");
  o = approve(root, config); // review -> fix, entry #1
  assert.equal(o.kind === "transitioned" && o.to, "fix");
  assert.equal(readState(root).fixAttempts, 1);

  let fixes = 0;
  doFix(root, config); fixes++; // fix #1
  o = improveIncomplete(root, config); // -> fix, entry #2
  assert.equal(o.kind === "transitioned" && o.to, "fix");
  assert.equal(readState(root).fixAttempts, 2);

  doFix(root, config); fixes++; // fix #2
  o = improveIncomplete(root, config); // -> fix, entry #3
  assert.equal(o.kind === "transitioned" && o.to, "fix");
  assert.equal(readState(root).fixAttempts, 3);

  doFix(root, config); fixes++; // fix #3
  o = improveIncomplete(root, config); // entry #4 would exceed cap -> escalate
  assert.equal(o.kind, "halted");
  assert.equal(o.kind === "halted" && o.reason, "escalation");

  assert.equal(fixes, 3, "exactly 3 fix executions (initial + 2 retries)");
  assert.equal(readState(root).fixAttempts, 3, "counter not incremented past the cap");
  assert.equal(readState(root).currentStep, "improve-check", "fix step was NOT entered a 4th time");
});

// Test 2 — increment happens only on confirmed Fix entry, not at improve-check completion.
test("2: fixAttempts unchanged when improve-check exits to a non-fix step", () => {
  const { root, config } = makeRoot();
  setStep(root, "improve-check", { fixAttempts: 1 });
  writeStatus(root, { step: "improve-check", result: "ready-for-reflection", reason: "x" });
  const before = readState(root).fixAttempts;
  const o = runStep(root, config, "improve-check");
  assert.equal(o.kind === "transitioned" && o.to, "reflection");
  assert.equal(readState(root).fixAttempts, before, "no increment on non-fix exit");

  setStep(root, "improve-check", { fixAttempts: 1 });
  writeStatus(root, { step: "improve-check", result: "fix-incomplete", reason: "x" });
  const o2 = runStep(root, config, "improve-check");
  assert.equal(o2.kind === "transitioned" && o2.to, "fix");
  assert.equal(readState(root).fixAttempts, 2, "increment only when entering fix");
});

// Test 3 — fix への差し戻しは improve-check の1経路だけ（config contract）。
// testing ステップ削除前は test-failed も同じ fixAttempts を消費していたが、
// テストの検証は verify-local validator が担うようになり経路ごと無くなった。
test("3: fix-incomplete is the only route back into fix", () => {
  const { config } = makeRoot();
  const fix = config.steps["fix"];
  assert.equal(fix.retryPolicy?.counter, "fixAttempts");
  assert.deepEqual(fix.retryPolicy?.retryOn, ["fix-incomplete"]);
  assert.equal(config.steps["improve-check"].transitions["fix-incomplete"].next, "fix");

  // fix を指す遷移が improve-check 以外に無いことを構造から確認する
  const intoFix = Object.entries(config.steps).flatMap(([id, step]) =>
    Object.entries(step.transitions)
      .filter(([, t]) => t.next === "fix")
      .map(([result]) => `${id}:${result}`)
  );
  assert.deepEqual(intoFix, ["review:fix-required", "improve-check:fix-incomplete"]);
});
