import { test } from "node:test";
import assert from "node:assert/strict";
import { runStep } from "../src/engine/engine.js";
import { readState } from "../src/engine/state.js";
import { makeRoot, setStep, writeIn, writeStatus, validContextPackage, validCodexPrompt, validResearchFindings } from "./helpers.js";

// Test 4 — invalid-status (result): improve-check returning `ready` halts (越境防止).
test("4: undeclared result halts with invalid-status, no transition", () => {
  const { root, config } = makeRoot();
  setStep(root, "improve-check");
  writeStatus(root, { step: "improve-check", result: "ready", reason: "x" });

  const out = runStep(root, config, "improve-check");
  assert.equal(out.kind, "halted");
  assert.equal(out.kind === "halted" && out.reason, "invalid-status");
  assert.equal(readState(root).currentStep, "improve-check");
});

// Test 5 — invalid-status (step): research produces "step":"review" and halts.
test("5: status.step mismatch halts with invalid-status", () => {
  const { root, config } = makeRoot();
  setStep(root, "research");
  writeIn(root, "context-package.md", validContextPackage());
  writeIn(root, "codex-prompt.md", validCodexPrompt);
  writeIn(root, "research-findings.md", validResearchFindings); // M1: research の必須出力
  writeStatus(root, { step: "review", result: "research-complete", reason: "x" });

  const out = runStep(root, config, "research");
  assert.equal(out.kind, "halted");
  assert.equal(out.kind === "halted" && out.reason, "invalid-status");
  assert.equal(readState(root).currentStep, "research");
});

// Test 5b — benign stale status: current-status.json still holds the *previous* step's
// declaration (status.step == lastCompletedStep) after an approve transitioned here. This is an
// operator timing slip, surfaced as a plain recoverable error — NOT a halt (no state mutation,
// no resume needed).
test("5b: stale current-status.json from the previous step errors without halting", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection", { lastCompletedStep: "review" });
  writeStatus(root, { step: "review", result: "ready", reason: "stale" });

  assert.throws(() => runStep(root, config, "reflection"), /still declares the previous step/);
  const s = readState(root);
  assert.equal(s.currentStep, "reflection"); // unchanged
  assert.equal(s.status, "ready"); // not "halted"
  assert.equal(s.haltedReason, null);
});
