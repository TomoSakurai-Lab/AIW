import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runValidators } from "../src/engine/validators.js";
import { makeRoot, writeIn } from "./helpers.js";

function customConfig(root: string, validators: any[]) {
  const { config } = makeRoot();
  return { ...config, steps: { ...config.steps, implementation: { ...config.steps.implementation, validators } } };
}

test("measurement-completeness: later skipped results are complete and not passed", () => {
  const { root } = makeRoot();
  writeIn(root, "ac-manifest.json", JSON.stringify({ acceptanceCriteria: [{ id: "AC-01", evidenceKind: "command" }, { id: "AC-02", evidenceKind: "browser" }] }));
  writeIn(root, "ac-result.json", JSON.stringify({ results: [{ id: "AC-01", status: "failed" }, { id: "AC-02", status: "skipped", reason: "先行失敗" }] }));
  const config = customConfig(root, [{ type: "measurement-completeness", onViolation: "report", manifest: "ac-manifest.json", result: "ac-result.json" }]);
  const outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.halt, false);
  assert.equal(outcome.results[0].status, "passed");
});

test("measurement-completeness: missing and duplicate AC results are reported", () => {
  const { root } = makeRoot();
  writeIn(root, "ac-manifest.json", JSON.stringify({ acceptanceCriteria: [{ id: "AC-01", evidenceKind: "command" }, { id: "AC-02", evidenceKind: "file" }] }));
  writeIn(root, "ac-result.json", JSON.stringify({ results: [{ id: "AC-01", status: "passed" }, { id: "AC-01", status: "skipped" }] }));
  const config = customConfig(root, [{ type: "measurement-completeness", onViolation: "report", manifest: "ac-manifest.json", result: "ac-result.json" }]);
  const outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.halt, false);
  assert.equal(outcome.results[0].status, "failed");
  assert.match(outcome.results[0].message, /AC-02/);
});

test("consumer-presence: zero, allowed, unimplemented, and report are distinct", () => {
  const { root } = makeRoot();
  mkdirSync(path.join(root, "src"), { recursive: true });
  const validator = { type: "consumer-presence", onViolation: "report", consumerRoot: "src", apiPattern: "\\bcallApi\\b", manifest: "ac-manifest.json", result: "ac-result.json" } as const;
  const zeroConfig = customConfig(root, [validator]);
  let outcome = runValidators(root, zeroConfig, zeroConfig.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "failed");
  assert.equal(outcome.halt, false);

  writeIn(root, "src/consumer.ts", "callApi();\n");
  outcome = runValidators(root, zeroConfig, zeroConfig.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "passed");

  writeIn(root, "ac-manifest.json", JSON.stringify({ acceptanceCriteria: [{ id: "AC-01", evidenceKind: "file", implementationStatus: "not-implemented" }] }));
  writeIn(root, "ac-result.json", JSON.stringify({ results: [{ id: "AC-01", status: "NOT VERIFIED" }] }));
  outcome = runValidators(root, zeroConfig, zeroConfig.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "failed");

  writeIn(root, "ac-manifest.json", JSON.stringify({ acceptanceCriteria: [{ id: "AC-01", evidenceKind: "file", implementationStatus: "not-checked" }] }));
  outcome = runValidators(root, zeroConfig, zeroConfig.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "passed");
});
