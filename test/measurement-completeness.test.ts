import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runValidators } from "../src/engine/validators.js";
import { makeRoot, writeIn } from "./helpers.js";

function customConfig(validators: any[]) {
  const { config } = makeRoot();
  return { ...config, steps: { ...config.steps, implementation: { ...config.steps.implementation, validators } } };
}

test("measurement-completeness: later skipped results are complete and not passed", () => {
  const { root } = makeRoot();
  writeIn(root, "ac-manifest.json", JSON.stringify({ acceptanceCriteria: [{ id: "AC-01", evidenceKind: "command" }, { id: "AC-02", evidenceKind: "browser" }] }));
  writeIn(root, "ac-result.json", JSON.stringify({ results: [{ id: "AC-01", status: "failed" }, { id: "AC-02", status: "skipped", reason: "先行失敗" }] }));
  const config = customConfig([{ type: "measurement-completeness", onViolation: "report", manifest: "ac-manifest.json", result: "ac-result.json" }]);
  const outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.halt, false);
  assert.equal(outcome.results[0].status, "passed");
});

test("measurement-completeness: missing and duplicate AC results are reported", () => {
  const { root } = makeRoot();
  writeIn(root, "ac-manifest.json", JSON.stringify({ acceptanceCriteria: [{ id: "AC-01", evidenceKind: "command" }, { id: "AC-02", evidenceKind: "file" }] }));
  writeIn(root, "ac-result.json", JSON.stringify({ results: [{ id: "AC-01", status: "passed" }, { id: "AC-01", status: "skipped" }] }));
  const config = customConfig([{ type: "measurement-completeness", onViolation: "report", manifest: "ac-manifest.json", result: "ac-result.json" }]);
  const outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.halt, false);
  assert.equal(outcome.results[0].status, "failed");
  assert.match(outcome.results[0].message, /AC-02/);
});

test("consumer-presence: manifest checks zero, allowed, misreport, and missing manifest", () => {
  const { root } = makeRoot();
  mkdirSync(path.join(root, "src"), { recursive: true });
  const validator = { type: "consumer-presence", onViolation: "report", manifest: "ac-manifest.json", result: "ac-result.json" } as const;
  const config = customConfig([validator]);

  let outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "skipped", "manifest 不在なら skipped");

  const consumerCheck = { id: "API-01", root: "src", pattern: "\\bcallApi\\b" };
  writeIn(root, "ac-manifest.json", JSON.stringify({ consumerChecks: [consumerCheck], acceptanceCriteria: [{ id: "AC-01", evidenceKind: "file" }] }));
  writeIn(root, "ac-result.json", JSON.stringify({ results: [{ id: "AC-01", status: "passed" }] }));
  outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "failed", "consumer 0件を検知");
  assert.equal(outcome.halt, false, "report は halt しない");

  writeIn(root, "ac-manifest.json", JSON.stringify({ consumerChecks: [consumerCheck], acceptanceCriteria: [{ id: "AC-01", evidenceKind: "file", implementationStatus: "not-implemented" }] }));
  writeIn(root, "ac-result.json", JSON.stringify({ results: [{ id: "AC-01", status: "NOT VERIFIED" }] }));
  outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.match(outcome.results[0].message, /unimplemented AC reported as NOT VERIFIED/);

  writeIn(root, "src/consumer.ts", "callApi();\n");
  writeIn(root, "ac-manifest.json", JSON.stringify({ consumerChecks: [consumerCheck], acceptanceCriteria: [{ id: "AC-01", evidenceKind: "file", implementationStatus: "not-checked" }] }));
  outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "passed", "許可 consumer と未検査を区別");
});
