import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { approve, reject, runStep } from "../src/engine/engine.js";
import { readState } from "../src/engine/state.js";
import { makeRoot, setStep, writeIn, writeStatus, validTask } from "./helpers.js";

// Test 8 — approval: reject(rerun) passes reason as input + reruns; no transition while pending;
// reject(halt) halts.
test("8a: reject(rerun) writes rejection-note, reruns, then approve transitions", () => {
  const { root, config } = makeRoot();
  setStep(root, "task-planning");
  writeIn(root, "current-task.md", validTask);
  writeStatus(root, { step: "task-planning", result: "planned", reason: "x" });

  let o = runStep(root, config, "task-planning");
  assert.equal(o.kind, "awaiting-approval");
  assert.equal(readState(root).currentStep, "task-planning", "no transition while pending approval");

  o = reject(root, config, "needs more detail");
  assert.equal(o.kind, "rerun");
  assert.ok(existsSync(path.join(root, "rejection-note.md")));
  assert.ok(readFileSync(path.join(root, "rejection-note.md"), "utf8").includes("needs more detail"));
  assert.equal(readState(root).pendingApproval, null);
  assert.equal(readState(root).currentStep, "task-planning");

  // rerun the step -> awaiting again -> approve -> transition
  o = runStep(root, config, "task-planning");
  assert.equal(o.kind, "awaiting-approval");
  o = approve(root, config);
  assert.equal(o.kind === "transitioned" && o.to, "research");
});

test("8b: reject(halt) sets halted(approval-rejected)", () => {
  const { root, config } = makeRoot();
  // Flip this instance's policy to halt-on-reject.
  (config.steps["task-planning"].approval as any).onReject = "halt";
  setStep(root, "task-planning");
  writeIn(root, "current-task.md", validTask);
  writeStatus(root, { step: "task-planning", result: "planned", reason: "x" });

  runStep(root, config, "task-planning");
  const o = reject(root, config, "stop");
  assert.equal(o.kind, "halted");
  assert.equal(o.kind === "halted" && o.reason, "approval-rejected");
  assert.equal(readState(root).status, "halted");
  assert.equal(readState(root).currentStep, "task-planning");
});
