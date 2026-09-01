import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

// ⚠️ **このテストは 2026-09-01 まで壊れた挙動を固定していた。**
// consumer root を runtimeRoot 配下（`<root>/src`）に作っており、validator が
// runtimeRoot 起点で解決していたから通っていた。本番の manifest は
// `Primal.Template.Web.Front/ClientApp/src` のような **checkRepoRoot 相対**を書くので、
// 本番では常に「存在しない」になり、ソーク窓で failed 8 件の偽陽性を出していた。
//
// テストが本番と違う土俵を作っていたことがバグを生き延びさせた。
// **consumer root は checkRepoRoot（= makeRoot が用意する git リポジトリ）側に置く。**
test("consumer-presence: manifest checks zero, allowed, misreport, and missing manifest", () => {
  const { root, repoRoot } = makeRoot(); // repoRoot = checkRepoRoot（runtimeRoot の親の git リポジトリ）
  mkdirSync(path.join(repoRoot, "src"), { recursive: true });
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

  writeFileSync(path.join(repoRoot, "src", "consumer.ts"), "callApi();\n", "utf8");
  writeIn(root, "ac-manifest.json", JSON.stringify({ consumerChecks: [consumerCheck], acceptanceCriteria: [{ id: "AC-01", evidenceKind: "file", implementationStatus: "not-checked" }] }));
  outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "passed", "許可 consumer と未検査を区別");

  // ⚠️ **runtimeRoot 起点の相対パスが誤って passed にならないこと**（今回の偽陽性の逆方向）。
  // runtimeRoot 配下にだけ consumer を置いても、checkRepoRoot 起点では見つからない。
  mkdirSync(path.join(root, "runtime-only"), { recursive: true });
  writeIn(root, "runtime-only/consumer.ts", "callApi();\n");
  writeIn(
    root,
    "ac-manifest.json",
    JSON.stringify({ consumerChecks: [{ id: "API-02", root: "runtime-only", pattern: "\\bcallApi\\b" }], acceptanceCriteria: [] })
  );
  outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "failed", "runtimeRoot 起点の相対は解決されない");
  assert.match(outcome.results[0].message, /consumer root does not exist/);
});

// manifest が知らないパス基準を名乗ったら **検査せず skipped**。
// 別基準で書かれた root を checkRepoRoot 起点で解決すると、存在しないパスを見て
// 「consumer 0 件」と報告する——今回直した偽陽性そのものなので、走らせない側へ倒す。
test("consumer-presence: an unknown pathBase is skipped, never failed", () => {
  const { root, repoRoot } = makeRoot();
  mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "src", "consumer.ts"), "callApi();\n", "utf8");
  const validator = { type: "consumer-presence", onViolation: "report", manifest: "ac-manifest.json", result: "ac-result.json" } as const;
  const config = customConfig([validator]);
  const checks = [{ id: "API-01", root: "src", pattern: "\\bcallApi\\b" }];

  writeIn(root, "ac-manifest.json", JSON.stringify({ pathBase: "runtimeRoot", consumerChecks: checks, acceptanceCriteria: [] }));
  let outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "skipped");
  assert.match(outcome.results[0].skipReason ?? "", /unknown pathBase/);
  assert.equal(outcome.halt, false);

  // 現行規約の明示は検査を止めない。省略時と同じ扱いになる。
  writeIn(root, "ac-manifest.json", JSON.stringify({ pathBase: "checkRepoRoot", consumerChecks: checks, acceptanceCriteria: [] }));
  outcome = runValidators(root, config, config.steps.implementation.validators);
  assert.equal(outcome.results[0].status, "passed", "checkRepoRoot の明示は省略時と同じ");
});

// checkRepoRoot を特定できないときは **skipped**。report 宣言の validator が
// 「検査できなかった」を「違反があった」と偽らないこと（verify-local のタイムアウトと同じ論理）。
test("consumer-presence: an unresolvable checkRepoRoot is skipped, never failed", () => {
  const { root } = makeRoot();
  const validator = { type: "consumer-presence", onViolation: "report", manifest: "ac-manifest.json", result: "ac-result.json" } as const;
  const base = customConfig([validator]);
  const config = { ...base, settings: { ...base.settings, repoRoot: "no/such/dir" } };

  writeIn(
    root,
    "ac-manifest.json",
    JSON.stringify({ consumerChecks: [{ id: "API-01", root: "src", pattern: "x" }], acceptanceCriteria: [] })
  );
  const outcome = runValidators(root, config, config.steps.implementation.validators);

  assert.equal(outcome.results[0].status, "skipped");
  assert.match(outcome.results[0].skipReason ?? "", /checkRepoRoot unresolved/, "第1部の可視化に乗る理由文字列");
  assert.equal(outcome.halt, false);
});
