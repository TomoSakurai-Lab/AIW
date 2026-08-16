import { test } from "node:test";
import assert from "node:assert/strict";
import { loadWorkflow } from "../src/engine/loader.js";
import { checkMarkdownSections } from "../src/engine/artifactContract.js";
import { runValidators } from "../src/engine/validators.js";
import { makeRoot, reviewMissingInnerCritical, seedReflectionOutputs, validReview, writeStatus, setStep } from "./helpers.js";

// Test 11 — loader injects `id` from the steps map key (§7.1).
test("11: loader injects step id from map key", () => {
  const { root } = makeRoot();
  const cfg = loadWorkflow(root);
  assert.equal(cfg.steps["task-planning"].id, "task-planning");
  assert.equal(cfg.steps["review"].id, "review");
  assert.equal(cfg.steps["improve-check"].id, "improve-check");
});

// Test 9 — artifact-contract: ordered subsequence with heading-level match (§7.4).
test("9: artifact-contract distinguishes ## Critical from ### Critical", () => {
  const { root, config } = makeRoot();
  const contract = config.artifacts["current-review"].contract;
  assert.equal(contract.type, "markdown-sections");
  const sections = contract.type === "markdown-sections" ? contract.sections : [];

  const good = checkMarkdownSections(validReview, sections);
  assert.equal(good.ok, true, `expected valid review to pass; missing: ${good.missing.join(", ")}`);

  // Missing the inner "### Critical" (Fix Scope). The outer "## Critical" must NOT substitute.
  const bad = checkMarkdownSections(reviewMissingInnerCritical, sections);
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes("### Critical"), `missing should list "### Critical": ${bad.missing.join(", ")}`);
});

// Test 10 — schema: feature-continue requires nextPhaseId; additionalProperties rejected (§7.5).
test("10: json-schema enforces feature-continue nextPhaseId + additionalProperties", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  seedReflectionOutputs(root); // M1: file-exists が task-metadata.json を要求する
  const validators = config.steps["reflection"].validators!;

  writeStatus(root, { step: "reflection", result: "feature-continue", reason: "x" });
  assert.equal(runValidators(root, config, validators).halt, true, "feature-continue without nextPhaseId must fail");

  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x", bogus: 1 });
  assert.equal(runValidators(root, config, validators).halt, true, "unknown field must fail (additionalProperties)");

  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });
  assert.equal(runValidators(root, config, validators).halt, false, "valid status must pass");

  writeStatus(root, { step: "reflection", result: "feature-continue", reason: "x", nextPhaseId: "phase-2" });
  assert.equal(runValidators(root, config, validators).halt, false, "feature-continue with nextPhaseId must pass");
});
