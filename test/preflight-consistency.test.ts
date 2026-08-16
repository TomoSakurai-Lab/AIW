import { test } from "node:test";
import assert from "node:assert/strict";
import { EngineError, nextSuggestion, runStep } from "../src/engine/engine.js";
import { readState } from "../src/engine/state.js";
import { makeRoot, setStep, writeIn, writeStatus } from "./helpers.js";

// Capture the thrown message while still asserting the error type.
function messageOf(fn: () => unknown): string {
  let message = "";
  assert.throws(fn, (error: Error) => {
    message = error.message;
    return error instanceof EngineError;
  });
  return message;
}

// A claude step whose current-status.json is stale from the previous step (the Test 5b setup).
function claudeStepWithStaleStatus() {
  const ctx = makeRoot();
  setStep(ctx.root, "reflection", { lastCompletedStep: "review" });
  writeStatus(ctx.root, { step: "review", result: "ready", reason: "stale" });
  return ctx;
}

// Test 20 — every declared step is runnable.
//
// 元はここで「role: cli のステップは stale-status プリフライトより先に弾く」を検証していた。
// testing（唯一の cli ステップ）を削除し role: cli もろとも無くしたので、検証対象を
// 「実行手段のない role を持つステップが宣言されていないこと」へ置き換える。
// これが破れると runStep が role を無視して完了処理へ進み、袋小路になる（KI-09）。
test("20: no declared step has a role the engine cannot execute", () => {
  const { config } = makeRoot();
  const runnable = new Set(["claude", "codex"]);

  const unrunnable = Object.values(config.steps)
    .filter((step) => !runnable.has(step.role))
    .map((step) => `${step.id}:${step.role}`);

  assert.deepEqual(unrunnable, [], "実行手段のない role を宣言すると袋小路になる");
});

// Test 21 — the `aiw next` side of the pre-flight (previously untested).
test("21: nextSuggestion detects a stale status and asks for a regenerated one", () => {
  const { root, config } = claudeStepWithStaleStatus();

  const stale = nextSuggestion(root, config);
  assert.match(stale.action, /regenerate current-status\.json for "reflection"/);
  assert.match(stale.reason, /still declares the previous step "review"/);

  // a status that declares the current step is not stale — back to the plain suggestion
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });
  assert.equal(nextSuggestion(root, config).action, "aiw run reflection");

  // neither is a status that declares some *other* step (that is a real mismatch, left to the
  // pipeline's invalid-status halt rather than the benign pre-flight)
  writeStatus(root, { step: "task-planning", result: "planned", reason: "x" });
  assert.equal(nextSuggestion(root, config).action, "aiw run reflection");
});

// Test 22 — malformed current-status.json is swallowed into `null`: the pre-flight stays quiet and
// the json-schema validator remains the one that reports it.
test("22: malformed current-status.json does not trigger the pre-flight", () => {
  const { root, config } = claudeStepWithStaleStatus();
  writeIn(root, "current-status.json", "{ this is not json");

  assert.equal(nextSuggestion(root, config).action, "aiw run reflection");

  const out = runStep(root, config, "reflection");
  assert.equal(out.kind, "halted");
  assert.equal(out.kind === "halted" && out.reason, "validation-failed");
});

// Test 23 — `aiw run` and `aiw next` must not contradict each other on the same state. The two
// copies of this pre-flight drifting apart is exactly what produced the dead end in Test 20.
test("23: run and next agree on the same state", () => {
  // (a) 未知のステップ: どちらも「不明」と答え、status 書き直しを案内しない
  const unknown = makeRoot();
  setStep(unknown.root, "not-a-step", { lastCompletedStep: "improve-check" });
  writeStatus(unknown.root, { step: "improve-check", result: "fix-incomplete", reason: "x" });
  const unknownNext = nextSuggestion(unknown.root, unknown.config);
  // 未知ステップは getStep が素の Error を投げる（EngineError ではない）ので個別に捕まえる
  let unknownRun = "";
  assert.throws(
    () => runStep(unknown.root, unknown.config, "not-a-step"),
    (e: Error) => {
      unknownRun = e.message;
      return true;
    }
  );

  assert.equal(unknownNext.action, "aiw status");
  assert.match(unknownRun, /Unknown step/);
  assert.doesNotMatch(`${unknownNext.action} ${unknownNext.reason}`, /regenerate current-status/);
  assert.doesNotMatch(unknownRun, /still declares/);

  // (b) claude step + stale status: both point at rewriting current-status.json
  const claude = claudeStepWithStaleStatus();
  const claudeNext = nextSuggestion(claude.root, claude.config);
  const claudeRun = messageOf(() => runStep(claude.root, claude.config, "reflection"));

  assert.match(claudeNext.action, /regenerate current-status\.json/);
  assert.match(claudeRun, /still declares the previous step "review"/);
});
