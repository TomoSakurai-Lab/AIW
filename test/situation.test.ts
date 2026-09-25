// M5 段階1: 状態の判定（drive / next / auto が共有する判定器）の固定。
//
// 設計は docs/design-auto.md 課題E。判定器の存在意義は「優先順位が1箇所に書かれ、テストで固定されている」こと。
//
// drive のループには自動テストが無い（対話ループのため。Test 106 のコメント）。ここでは実物の runDrive を
// サブプロセスで動かし、**分岐の中で終了する経路だけ**を固定する（ステップ不明 / 終端 / halt に n と答える）。
// ⚠️ クリップボードや executor へ進む経路はサブプロセスで動かさない——ユーザーの OS クリップボードを汚すため。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, nextSuggestion } from "../src/engine/engine.js";
import { rootPaths } from "../src/engine/paths.js";
import { makeRoot, setStep } from "./helpers.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 実物の `aiw drive` を動かし、標準出力を返す。stdin はすべて先に渡して閉じる。 */
function drive(root: string, input: string): string {
  const r = spawnSync(
    process.execPath,
    [path.join(PKG, "node_modules", "tsx", "dist", "cli.js"), path.join(PKG, "src", "cli.ts"), "--root", root, "drive"],
    { input, encoding: "utf8", windowsHide: true, timeout: 120_000, cwd: PKG }
  );
  assert.equal(r.error, undefined, `drive を起動できない: ${r.error?.message}`);
  return r.stdout;
}

const HALTED = { status: "halted", haltedReason: "validation-failed" };
const PENDING = { from: "review", to: "fix", result: "fix-required", isRetry: false, completedPostActions: [] };

/** 終端を2つ持つ workflow（review-audit の遷移先を `audited` にする）。 */
function makeTwoTerminalRoot() {
  const ctx = makeRoot();
  const file = rootPaths(ctx.root).workflowYaml;
  const yaml = readFileSync(file, "utf8");
  const edited = yaml.replace("      audit-complete:\n        next: complete", "      audit-complete:\n        next: audited");
  assert.notEqual(edited, yaml, "fixture: review-audit の遷移先を書き換えられなかった");
  writeFileSync(file, edited, "utf8");
  return { ...ctx, config: loadConfig(ctx.root) };
}

// Test 188 — drive: 1つの条件だけが成り立つ状態で、分岐の中で終わる経路。
test("188: drive ends inside the branch for unknown / complete / halted", () => {
  const { root } = makeRoot();

  setStep(root, "not-a-step");
  assert.match(drive(root, "n\n"), /"not-a-step" は不明です/);

  setStep(root, "complete");
  assert.match(drive(root, "n\n"), /ワークフロー完了/);

  setStep(root, "review", HALTED);
  const halted = drive(root, "n\n");
  assert.match(halted, /HALTED \(validation-failed\) at "review"/);
  assert.match(halted, /resume しますか/);
});

// Test 189 — drive: 定義済みのステップで条件が重なったとき、halted が承認待ち・チェックポイントに勝つ。
test("189: drive puts halted ahead of approval and checkpoint on a defined step", () => {
  const { root } = makeRoot();

  setStep(root, "review", { ...HALTED, pendingApproval: "review" });
  const withApproval = drive(root, "n\n");
  assert.match(withApproval, /HALTED \(validation-failed\)/);
  assert.doesNotMatch(withApproval, /承認ゲート/);

  setStep(root, "review", { ...HALTED, pendingTransition: PENDING });
  const withCheckpoint = drive(root, "n\n");
  assert.match(withCheckpoint, /HALTED \(validation-failed\)/);
  assert.doesNotMatch(withCheckpoint, /チェックポイント/);
});

// Test 190 — drive: 未定義のステップと halt / 承認待ちが同時に成り立つ（課題E の表の1）。
// ⚠️ **判定器を統一する前の挙動を固定している。** 今の drive は「ステップ未定義」を最初に見るので、
// halt や承認待ちが立っていても「不明」と言って終わる。統一後はここの期待値が変わる（変わること自体が報告対象）。
test("190: drive with an undefined step alongside halted / approval (behaviour before unification)", () => {
  const { root } = makeRoot();

  setStep(root, "not-a-step", HALTED);
  const halted = drive(root, "n\n");
  assert.match(halted, /"not-a-step" は不明です/);
  assert.doesNotMatch(halted, /HALTED/);

  setStep(root, "not-a-step", { pendingApproval: "review" });
  const approval = drive(root, "n\nfixture\n");
  assert.match(approval, /"not-a-step" は不明です/);
  assert.doesNotMatch(approval, /承認ゲート/);
});

// Test 191 — drive: `complete` 以外の名前の終端（課題E の表の2）。
// ⚠️ **判定器を統一する前の挙動を固定している。** 今の drive は文字列 "complete" と比べるので、
// config 上は終端である `audited` を「不明」と言う。統一後は終端として正しく終わる。
test("191: drive at a terminal not named complete (behaviour before unification)", () => {
  const { root } = makeTwoTerminalRoot();

  setStep(root, "complete");
  assert.match(drive(root, "n\n"), /ワークフロー完了/);

  setStep(root, "audited");
  const audited = drive(root, "n\n");
  assert.match(audited, /"audited" は不明です/);
  assert.doesNotMatch(audited, /ワークフロー完了/);
});

// Test 192 — next: 条件が重なったときの優先順位。next は統一の前後で**変わってはいけない**。
test("192: next resolves overlapping conditions in its declared order", () => {
  const { root, config } = makeRoot();
  const next = (): string => nextSuggestion(root, config).action;

  // 定義済みのステップで3つとも立てる → halted
  setStep(root, "review", { ...HALTED, pendingApproval: "review", pendingTransition: PENDING });
  assert.equal(next(), "aiw resume");
  assert.match(nextSuggestion(root, config).reason, /^halted/);

  // halted を外す → 承認待ち
  setStep(root, "review", { pendingApproval: "review", pendingTransition: PENDING });
  assert.equal(next(), "aiw approve | aiw reject <reason>");

  // 承認待ちも外す → チェックポイント
  setStep(root, "review", { pendingTransition: PENDING });
  assert.equal(next(), "aiw resume");
  assert.match(nextSuggestion(root, config).reason, /post-action checkpoint/);

  // 未定義のステップでも、halt / 承認待ちが先
  setStep(root, "not-a-step", HALTED);
  assert.equal(next(), "aiw resume");
  setStep(root, "not-a-step", { pendingApproval: "review" });
  assert.equal(next(), "aiw approve | aiw reject <reason>");
  setStep(root, "not-a-step", { pendingTransition: PENDING });
  assert.equal(next(), "aiw resume");

  // 何も立っていない未定義のステップ → 不明
  setStep(root, "not-a-step");
  assert.equal(next(), "aiw status");
});

// Test 193 — next: 終端が2つある workflow で、どちらの終端でも new-task を提案する。
test("193: next treats every configured terminal as terminal", () => {
  const { root, config } = makeTwoTerminalRoot();

  for (const terminal of ["complete", "audited"]) {
    setStep(root, terminal);
    const s = nextSuggestion(root, config);
    assert.equal(s.action, "aiw new-task", terminal);
    assert.match(s.reason, new RegExp(`terminal state "${terminal}"`));
  }
});
