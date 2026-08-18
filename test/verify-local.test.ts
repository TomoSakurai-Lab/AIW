// verify-local（M1.5 第3部）。
//
// 中心的な関心は「コマンドが走ったか」ではなく **「実際に何を見たか」** が分かること。
// `tsc --noEmit` は対象0件でも exit 0 を返すので、diff-scope と同じく
// 「検査していない」を「問題なし」に見せない仕組みが要る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runStep } from "../src/engine/engine.js";
import { runValidators } from "../src/engine/validators.js";
import { countCheckedFiles, knownFailureHint, runVerifyLocal, scopeNote } from "../src/engine/verifyLocal.js";
import { makeRoot, setStep, validResult, writeIn, writeStatus } from "./helpers.js";

// node を直接叩くので、環境に npx/tsc が無くても成立する。
//
// `-e` のワンライナーは使わない: runVerifyLocal は Windows で shell: true を使う（npx が
// .cmd のため）ので、引用符・括弧・矢印関数を含む argv はシェルに再解釈されて壊れる。
// 実運用の command（["npx","tsc","--noEmit","--listFiles"]）に特殊文字は無いが、
// テストでは踏むのでスクリプトファイルへ書き出す。
const nodeExe = process.execPath;

function script(repoRoot: string, name: string, body: string): string {
  const file = path.join(repoRoot, name);
  writeFileSync(file, body, "utf8");
  return file;
}

function withVerifyLocal(config: ReturnType<typeof makeRoot>["config"], spec: Record<string, unknown>) {
  return { ...config, settings: { ...config.settings, verifyLocal: { typecheck: spec } } };
}

// Test 74 — --listFiles の出力からファイル数を数える。エラー行は数えない。
test("74: countCheckedFiles counts source paths, not error lines", () => {
  const out = [
    "C:/repo/src/a.ts",
    "C:/repo/node_modules/dep/index.d.ts",
    "/home/repo/src/b.ts",
    "src/c.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "",
    "C:/repo/src/d.tsx"
  ].join("\n");

  assert.equal(countCheckedFiles(out), 3, "node_modules とエラー行と空行を除く");
  assert.equal(countCheckedFiles(out, []), 4, "除外指定なしなら node_modules も数える");
  assert.equal(countCheckedFiles(""), 0);
});

// Test 75 — 失敗は failed。終了コードとファイル数が detail に載る。
test("75: a non-zero exit is failed and carries the scope", () => {
  const { root, config, repoRoot } = makeRoot();
  const two = script(repoRoot, "two-files-fail.js", [
    "console.log('C:/repo/src/a.ts');",
    "console.log('C:/repo/src/b.ts');",
    "process.exit(2);"
  ].join("\n"));
  const cfg = withVerifyLocal(config, { command: [nodeExe, two], notChecked: "C#/.NET" });

  const outcome = runVerifyLocal(repoRoot, cfg.settings.verifyLocal!.typecheck);
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" && outcome.exitCode, 2);
  assert.equal(outcome.kind === "failed" && outcome.fileCount, 2);

  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  writeIn(root, "context-package.md", "# Files\n## Modify\n- `x.ts`\n");
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });
  const r = runValidators(root, cfg, config.steps["implementation"].validators!, {
    stepId: "implementation",
    fixAttempts: 0
  }).results.find((x) => x.type === "verify-local")!;

  assert.equal(r.status, "failed");
  assert.match(r.message, /2 source files/, "何件見たかを必ず出す");
  assert.match(r.message, /C#\/\.NET not checked/, "見ていない範囲も必ず出す");
});

// Test 76 — 成功しても検査範囲を出す。「通った」だけでは何を見たか分からない。
test("76: a passing run still reports how much it checked", () => {
  const { repoRoot } = makeRoot();
  const one = script(repoRoot, "one-file.js", "console.log('C:/repo/src/a.ts');\n");
  const spec = { command: [nodeExe, one], notChecked: "C#/.NET" };

  const outcome = runVerifyLocal(repoRoot, spec);
  assert.equal(outcome.kind, "passed");
  assert.equal(outcome.kind === "passed" && outcome.fileCount, 1);

  const note = scopeNote(spec, 1, 1234);
  assert.match(note, /1 source files/);
  assert.match(note, /\(1\.2s\)/);
  assert.match(note, /C#\/\.NET not checked/);
});

// Test 77 — **0件は skipped。** exit 0 でも「検査した」ことにしない。
// cwd 誤り・tsconfig 破壊・include 漏れはすべてこの形で現れる。
test("77: checking zero files is skipped, never passed", () => {
  const { root, config, repoRoot } = makeRoot();
  const silent = script(repoRoot, "silent-ok.js", "process.exit(0);\n"); // 何も出力せず成功する
  const cfg = withVerifyLocal(config, { command: [nodeExe, silent] });

  const outcome = runVerifyLocal(repoRoot, cfg.settings.verifyLocal!.typecheck);
  assert.equal(outcome.kind, "skipped");
  assert.equal(outcome.kind === "skipped" && outcome.fileCount, 0);
  assert.match(outcome.kind === "skipped" ? outcome.reason : "", /0 source files/);

  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });
  const r = runValidators(root, cfg, config.steps["implementation"].validators!, {
    stepId: "implementation",
    fixAttempts: 0
  }).results.find((x) => x.type === "verify-local")!;

  assert.equal(r.status, "skipped", "exit 0 でも passed にしない");
  assert.match(r.skipReason ?? "", /verify cwd \/ tsconfig/);
});

// Test 78 — タイムアウトは skipped。「型エラーがあった」ではなく「検査が完了しなかった」。
test("78: a timeout is skipped, not failed", () => {
  const { repoRoot } = makeRoot();
  const sleeper = script(repoRoot, "sleeper.js", "setTimeout(function () {}, 30000);\n");
  const outcome = runVerifyLocal(repoRoot, { command: [nodeExe, sleeper], timeoutMs: 700 });

  assert.equal(outcome.kind, "skipped", "failed にすると意味的に偽ることになる");
  assert.match(outcome.kind === "skipped" ? outcome.reason : "", /timed out|killed by/);
});

// Test 79 — 設定不足・cwd 不在も skipped（report 宣言なので違反と偽らない）。
test("79: missing configuration and a bad cwd are skipped with a reason", () => {
  const { root, config, repoRoot } = makeRoot();

  assert.equal(runVerifyLocal(repoRoot, { command: [] }).kind, "skipped");
  const badCwd = runVerifyLocal(repoRoot, { cwd: "does/not/exist", command: [nodeExe, "--version"] });
  assert.equal(badCwd.kind, "skipped");
  assert.match(badCwd.kind === "skipped" ? badCwd.reason : "", /cwd does not exist/);

  // settings.verifyLocal に該当キーが無い場合
  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });
  const r = runValidators(root, config, config.steps["implementation"].validators!, {
    stepId: "implementation",
    fixAttempts: 0
  }).results.find((x) => x.type === "verify-local")!;
  assert.equal(r.status, "skipped");
  assert.match(r.skipReason ?? "", /is not defined/);
});

// Test 80 — 失敗は test-report.md として review へ渡り、通れば消える。
test("80: test-report.md is written on failure and removed when it passes", () => {
  const { root, config, repoRoot } = makeRoot();
  const bad = script(repoRoot, "typecheck-fail.js", [
    "console.log('C:/repo/src/a.ts');",
    "console.error('src/a.ts(1,1): error TS1005: oops');",
    "process.exit(2);"
  ].join("\n"));
  const failing = withVerifyLocal(config, { command: [nodeExe, bad], notChecked: "C#/.NET" });

  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  writeIn(root, "context-package.md", "# Files\n## Modify\n- `x.ts`\n");
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });

  const report = path.join(root, "test-report.md");
  const out = runStep(root, failing, "implementation");
  assert.equal(out.kind, "transitioned", "report 宣言なのでフローは止まらない");
  assert.ok(existsSync(report));

  const body = readFileSync(report, "utf8");
  assert.match(body, /# Verify Local Report/);
  assert.match(body, /走査ファイル数: 1/);
  assert.match(body, /検査していない範囲: C#\/\.NET/, "見ていない範囲をレポートにも書く");
  assert.match(body, /error TS1005/);

  // 通ったら消す。残ると review が解決済みの失敗を現在のものとして読む
  const good = script(repoRoot, "typecheck-ok.js", "console.log('C:/repo/src/a.ts');\n");
  const passing = withVerifyLocal(config, { command: [nodeExe, good] });
  setStep(root, "implementation");
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });
  runStep(root, passing, "implementation");
  assert.equal(existsSync(report), false, "古いレポートは残さない");
});

test("known failure patterns: NU1301 is presented, unknown output is not", () => {
  const patterns = [{ pattern: "NU1301", guidance: "NUGET_PACKAGES を設定して再実行" }];
  assert.equal(knownFailureHint("error NU1301: unable to load", patterns), "既知パターン提示: NUGET_PACKAGES を設定して再実行");
  assert.equal(knownFailureHint("error TS2322", patterns), null);
});

test("known failure report does not halt the step", () => {
  const { root, config, repoRoot } = makeRoot();
  const bad = script(repoRoot, "known-failure.js", [
    "console.log('C:/repo/src/a.ts');",
    "console.error('NU1301: unable to load package');",
    "process.exit(2);"
  ].join("\n"));
  const cfg = { ...config, settings: { ...config.settings, verifyLocal: { typecheck: { command: [nodeExe, bad], knownFailurePatterns: [{ pattern: "NU1301", guidance: "NUGET_PACKAGES を設定して再実行" }] } } }, steps: { ...config.steps, implementation: { ...config.steps.implementation, validators: [{ type: "verify-local", onViolation: "report", command: "typecheck" }] } } };
  const outcome = runValidators(root, cfg, cfg.steps.implementation.validators);
  assert.equal(outcome.halt, false);
  assert.equal(outcome.results[0].status, "failed");
  assert.match(outcome.results[0].message, /既知パターン提示/);
});
