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
import { classifySituation, loadConfig, nextSuggestion, type Situation } from "../src/engine/engine.js";
import { DEFAULT_ENGINE_STATE, type EngineState } from "../src/engine/types.js";
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
// **判定器の統一で挙動が変わった点。** 統一前の drive は「ステップ未定義」を最初に見ていたので、
// halt や承認待ちが立っていても「不明」と言って終わっていた（この期待値の書き換えの差分が変化の記録）。
// 統一後は優先順位表どおり halt / 承認待ちが先に出る。
test("190: drive puts halted / approval ahead of an undefined step (changed by unification)", () => {
  const { root } = makeRoot();

  setStep(root, "not-a-step", HALTED);
  const halted = drive(root, "n\n");
  assert.match(halted, /HALTED \(validation-failed\) at "not-a-step"/);
  assert.match(halted, /resume しますか/);
  assert.doesNotMatch(halted, /は不明です/);

  // 承認待ちが先に出る。却下するとループへ戻り、そこで初めて「不明」になって終わる
  //（クリップボードにも executor にも進まない）。
  setStep(root, "not-a-step", { pendingApproval: "review" });
  const approval = drive(root, "n\nfixture\n");
  assert.match(approval, /承認ゲート: "review"/);
  assert.ok(approval.indexOf("承認ゲート") < approval.indexOf("は不明です"), "承認ゲートが「不明」より先に出る");
});

// Test 191 — drive: 終端が2つある workflow（課題E の表の2・承認時の注文）。
// **判定器の統一で挙動が変わった点。** 統一前の drive は文字列 "complete" と比べていたので、
// config 上は終端である `audited` を「不明」と言っていた。統一後は config から導出するので、
// **どちらの終端でも正しく終わる**。終端が増えた日のための実証（next 側は Test 193）。
test("191: drive ends correctly at both terminals of a two-terminal workflow (changed by unification)", () => {
  const { root } = makeTwoTerminalRoot();

  for (const terminal of ["complete", "audited"]) {
    setStep(root, terminal);
    const out = drive(root, "n\n");
    assert.match(out, /ワークフロー完了/, terminal);
    assert.doesNotMatch(out, /は不明です/, terminal);
  }
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

// Test 194 — 判定の優先順位（docs/design-auto.md 課題E「判定の優先順位」表）を**組み合わせで**固定する。
//
// 判定器の存在意義は「順序が1箇所に書かれ、テストで固定されている」こと。複数の条件が同時に立つとき
// どれを見せるかは if の並びで暗黙に決まってしまうので、ここで全組み合わせを列挙して表と突き合わせる。
// halted / 承認待ち / チェックポイントの有無（2 × 2 × 2）× ステップの種類（定義済み / 終端 / 不明）= 24 通り。
//
// ⚠️ **条件を足すとき（auto の停止条件が増えるときなど）は、設計文書の表・classifySituation・
// この PRIORITY の3つに同じ行を足す。** どれか1つだけを変えると、このテストが落ちるか、表が嘘になる。
const PRIORITY: Situation["kind"][] = ["halted", "awaiting-approval", "checkpoint", "terminal", "unknown", "runnable"];

test("194: classifySituation follows the declared priority for every combination of conditions", () => {
  const { config } = makeRoot();
  const stepKinds = { defined: "review", terminal: "complete", unknown: "not-a-step" } as const;
  const seen = new Set<string>();

  for (const halted of [false, true]) {
    for (const approval of [false, true]) {
      for (const checkpoint of [false, true]) {
        for (const [where, currentStep] of Object.entries(stepKinds)) {
          const state: EngineState = {
            ...DEFAULT_ENGINE_STATE,
            currentStep,
            status: halted ? "halted" : "ready",
            haltedReason: halted ? "validation-failed" : null,
            pendingApproval: approval ? "review" : null,
            pendingTransition: checkpoint ? PENDING : null
          };
          // 立っている条件を表の語彙で並べ、表の上から最初に当たるものが期待値
          const raised = new Set<Situation["kind"]>();
          if (halted) raised.add("halted");
          if (approval) raised.add("awaiting-approval");
          if (checkpoint) raised.add("checkpoint");
          raised.add(where === "defined" ? "runnable" : (where as "terminal" | "unknown"));
          const expected = PRIORITY.find((kind) => raised.has(kind));

          const got = classifySituation(state, config);
          const label = JSON.stringify({ halted, approval, checkpoint, where });
          assert.equal(got.kind, expected, label);
          seen.add(label);
        }
      }
    }
  }
  assert.equal(seen.size, 24, "全組み合わせを確かめた");

  // 状況が運ぶ値（表示と auto が使う）
  const base = { ...DEFAULT_ENGINE_STATE, currentStep: "review" };
  assert.deepEqual(classifySituation({ ...base, status: "halted", haltedReason: "escalation" }, config), {
    kind: "halted",
    step: "review",
    reason: "escalation"
  });
  assert.deepEqual(classifySituation({ ...base, pendingApproval: "review" }, config), { kind: "awaiting-approval", step: "review" });
  const runnable = classifySituation(base, config);
  assert.equal(runnable.kind === "runnable" && runnable.step.id, "review");
});
