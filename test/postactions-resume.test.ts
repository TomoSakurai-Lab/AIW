import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { processCompletion, resume } from "../src/engine/completion.js";
import { defaultPostActions, type PostActionRegistry } from "../src/engine/postActions.js";
import { runStep } from "../src/engine/engine.js";
import { readState } from "../src/engine/state.js";
import { archivedTaskDirs, corruptStatus, makeRoot, seedReflectionOutputs, setStep, validFeature, writeIn, writeStatus, validResult } from "./helpers.js";

// Test 6 — validation before destructive postActions: reflection schema failure ⇒ neither
// restoreTemplates nor archiveArtifacts ran.
test("6: failed validation leaves destructive postActions un-run", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  seedReflectionOutputs(root);
  writeIn(root, "current-task.md", "DIRTY-SENTINEL");
  // `bogus` violates additionalProperties -> schema halt (before postActions).
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x", bogus: true });

  const o = runStep(root, config, "reflection");
  assert.equal(o.kind, "halted");
  assert.equal(o.kind === "halted" && o.reason, "validation-failed");
  assert.equal(readFileSync(path.join(root, "current-task.md"), "utf8"), "DIRTY-SENTINEL", "restoreTemplates must not have run");
  assert.deepEqual(archivedTaskDirs(root), [], "archiveArtifacts must not have run");
});

// Test 7 — postAction failure + resume: archiveArtifacts ok, restoreTemplates fails ⇒
// halted(post-action-failed); resume retries from restoreTemplates, archiveArtifacts not doubled.
test("7: resume finishes postActions idempotently after a failure", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  seedReflectionOutputs(root);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });

  let archiveCount = 0;
  let restoreCount = 0;
  let failOnce = true;
  const reg: PostActionRegistry = {
    ...defaultPostActions,
    archiveArtifacts: (ctx) => {
      archiveCount++;
      defaultPostActions.archiveArtifacts(ctx);
    },
    restoreTemplates: (ctx) => {
      restoreCount++;
      if (failOnce) {
        failOnce = false;
        throw new Error("disk full");
      }
      defaultPostActions.restoreTemplates(ctx);
    }
  };

  let o = runStep(root, config, "reflection", { postActions: reg });
  assert.equal(o.kind, "halted");
  assert.equal(o.kind === "halted" && o.reason, "post-action-failed");
  assert.equal(archiveCount, 1);
  assert.equal(restoreCount, 1);
  assert.equal(readState(root).currentStep, "reflection", "transition not committed on failure");

  o = resume(root, config, { postActions: reg });
  assert.equal(o.kind, "transitioned");
  assert.equal(o.kind === "transitioned" && o.to, "complete");
  assert.equal(archiveCount, 1, "archiveArtifacts must NOT be double-run");
  assert.equal(restoreCount, 2, "restoreTemplates retried on resume");
  assert.equal(readState(root).fixAttempts, 0, "resetFixAttempts ran");
  assert.equal(readState(root).currentStep, "complete");
  assert.equal(readState(root).pendingTransition, null);
});

// Test 7b — M2: resume on the post-action checkpoint path must SKIP validations 2–5.
// Directly observed via an `onValidate` counter (not inferred from file state or halt).
test("7b: resume skips validations 2–5 on the post-action checkpoint path", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  seedReflectionOutputs(root);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });

  let failOnce = true;
  const reg: PostActionRegistry = {
    ...defaultPostActions,
    restoreTemplates: (ctx) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("disk full");
      }
      defaultPostActions.restoreTemplates(ctx);
    }
  };

  let validateCalls = 0;
  const onValidate = () => {
    validateCalls++;
  };

  // Initial run enters the validation phase once, then fails in postActions.
  let o = runStep(root, config, "reflection", { postActions: reg, onValidate });
  assert.equal(o.kind === "halted" && o.reason, "post-action-failed");
  assert.equal(validateCalls, 1, "initial run performed validations 2–5");

  // Corrupt current-status.json: if resume re-ran validations 2–5 it would halt on this.
  corruptStatus(root);

  const before = validateCalls;
  o = resume(root, config, { postActions: reg, onValidate });
  assert.equal(o.kind, "transitioned");
  assert.equal(o.kind === "transitioned" && o.to, "complete");
  assert.equal(validateCalls, before, "resume did NOT re-enter validations 2–5 (direct observation)");
});

// Test 12 — crash before commit (step 9) ⇒ resume re-validates from step 2 with old currentStep.
// Uses `implementation` (no approval gate) so the pipeline reaches the pre-commit seam.
test("12: resume re-validates from step 2 after a pre-commit crash", () => {
  const { root, config } = makeRoot();
  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });

  assert.throws(() => processCompletion(root, config, readState(root), "implementation", { faultBeforeCommit: true }));
  assert.equal(readState(root).currentStep, "implementation", "nothing committed (currentStep still old)");
  assert.equal(readState(root).status, "ready");

  // Direct observation (contrast with 7b): the clean-interruption resume DOES re-enter 2–5.
  let validateCalls = 0;
  const o = resume(root, config, { onValidate: () => validateCalls++ });
  assert.equal(o.kind, "transitioned");
  assert.equal(o.kind === "transitioned" && o.to, "review");
  assert.equal(readState(root).currentStep, "review");
  assert.equal(validateCalls, 1, "resume re-entered validations 2–5 on the clean-interruption path");
});

// Test 13 — M1 acceptance: feature-continue with an unknown nextPhaseId halts invalid-status,
// and (assertion 3, most important) NO destructive postAction ran — mechanically forcing the
// M1 check to live in the validation phase, not inside advancePhase.
test("13: feature-continue with an unknown nextPhaseId halts invalid-status", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  seedReflectionOutputs(root);
  writeIn(root, "feature.md", validFeature(["phase-1", "phase-2"]));
  writeIn(root, "current-task.md", "ORIG-TASK"); // sentinel: detects restoreTemplates
  writeStatus(root, { step: "reflection", result: "feature-continue", reason: "x", nextPhaseId: "phase-9" });

  const o = runStep(root, config, "reflection");
  assert.equal(o.kind, "halted");
  assert.equal(o.kind === "halted" && o.reason, "invalid-status");
  assert.equal(readState(root).currentStep, "reflection", "no transition committed");
  // 3 (most important): destructive postActions did NOT run.
  assert.equal(readFileSync(path.join(root, "current-task.md"), "utf8"), "ORIG-TASK", "restoreTemplates must not have run");
  assert.deepEqual(archivedTaskDirs(root), [], "archiveArtifacts must not have run");
  assert.ok(readFileSync(path.join(root, "feature.md"), "utf8").includes("Current phase: phase-1"), "feature.md phase unchanged");

  // Positive control: a valid nextPhaseId advances feature.md and transitions to task-planning.
  setStep(root, "reflection"); // clear the halt
  writeStatus(root, { step: "reflection", result: "feature-continue", reason: "x", nextPhaseId: "phase-2" });
  const o2 = runStep(root, config, "reflection");
  assert.equal(o2.kind, "transitioned");
  assert.equal(o2.kind === "transitioned" && o2.to, "task-planning");
  assert.ok(readFileSync(path.join(root, "feature.md"), "utf8").includes("Current phase: phase-2"), "feature.md advanced");
});
