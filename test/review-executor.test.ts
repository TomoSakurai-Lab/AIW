// M4 段階1-2: review を Claude executor へ。
//
// ここで固定するのは**三層防御の review 版**と、それを支える宣言:
//   第1網 … ツール集合（Write 無し / Edit は成果物2本 / Bash は列挙のみ）
//   第2網 … diff-scope(report)。**review 入場で baseline が取り直される**こと
//   提案  … review-audit の model-change トリガー（宣言だけの機構にしない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { suggestAuditOnModelChange } from "../src/engine/audit.js";
import { runStep } from "../src/engine/engine.js";
import { appendEvent } from "../src/engine/eventLog.js";
import { allowRules, createClaudeExecutor, toolSet } from "../src/engine/executors/claude.js";
import { captureIfAbsent } from "../src/engine/gitScope.js";
import { runValidators } from "../src/engine/validators.js";
import type { WorkflowStep } from "../src/engine/types.js";
import { makeRoot, setStep, validResult, writeIn, writeStatus } from "./helpers.js";

const REVIEW_BASH = [
  "git diff:*",
  "git status:*",
  "dotnet build:*",
  "./tools/nrun.cmd:*",
  "grep:*",
  "echo:*",
  "head:*"
];

/** 運用の review 宣言（runtime 側）を再現する。assets は clipboard のままなので、ここで足す。 */
function reviewStep(base: WorkflowStep): WorkflowStep {
  return { ...base, executor: "claude", effort: "high", bashAllow: REVIEW_BASH };
}

function fakeClaude() {
  const captured = { argv: [] as string[] };
  const launch = (argv: string[]) => {
    captured.argv = argv;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handlers: { close?: (c: number | null, s: NodeJS.Signals | null) => void } = {};
    setTimeout(() => {
      stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {} })}\n`);
      stdout.end();
      handlers.close?.(0, null);
    }, 1);
    return {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => handlers.close?.(null, "SIGTERM" as NodeJS.Signals),
      on(event: string, cb: any) {
        if (event === "close") handlers.close = cb;
      }
    };
  };
  return { launch, captured };
}

// Test 147 — review の第1網。**Write は渡さず、Edit は成果物2本だけ、Bash は列挙のみ。**
test("147: review gets a reviewer's toolset — read, run the declared commands, edit only its own two artifacts", async () => {
  const { root, config } = makeRoot();
  mkdirSync(path.join(root, ".claude-home"), { recursive: true });
  const step = reviewStep(config.steps["review"]);

  assert.equal(toolSet(step), "Read,Grep,Glob,Bash,Edit");

  const rules = allowRules(root, step);
  const edits = rules.filter((r) => r.startsWith("Edit("));
  assert.equal(edits.length, 2, "current-review.md と current-status.json だけ");
  assert.ok(edits.some((r) => r.endsWith("current-review.md)")));
  assert.ok(edits.some((r) => r.endsWith("current-status.json)")));
  // ⚠️ リポジトリ側は1本も許可しない——**これが第1網の本体**。
  // 第2網（diff-scope）は Modify 宣言済みファイルを見逃すので（BL-115）、
  // review が最も触りたくなる集合を止めているのはここだけ。
  assert.equal(edits.some((r) => r.includes("/src/") || r.includes("ClientApp")), false);

  const bash = rules.filter((r) => r.startsWith("Bash("));
  assert.deepEqual(bash, REVIEW_BASH.map((c) => `Bash(${c})`), "宣言した順にそのまま渡す");
  // ⚠️ 実測（2026-09-04）: 複合コマンドは**各部が評価される**ので、
  // パイプの相方（echo / head）まで列挙しないと拒否される。広い許可で誤魔化さない。
  assert.ok(bash.includes("Bash(echo:*)") && bash.includes("Bash(head:*)"));
  // ⚠️ シェル経由の書き込みは1つも許可しない（実測: `cat > file <<EOF` は拒否され、
  // モデルはパス限定の Edit へ切り替えた）。許すと Edit のパス制限を迂回できる。
  assert.equal(
    bash.some((r) => /\b(cat|tee|cp|mv|sed|python|node|powershell)\b/.test(r)),
    false
  );

  const { launch, captured } = fakeClaude();
  await createClaudeExecutor({ launch }).execute({ root, config, step, projectRoot: root });
  assert.equal(captured.argv.includes("Write"), false, "Write はツールとしても許可としても渡らない");
  assert.equal(captured.argv[captured.argv.indexOf("--effort") + 1], "high", "review は effort: high");
});

// Test 148 — 第2網。**review 入場で baseline が取り直される**（誤帰属しない）。
//
// エンジン規則: 遷移先が diff-scope を宣言していれば遷移確定時に captureIfAbsent。
// したがって implementation の正当な変更は review の baseline に吸収され、
// **review 中に入った変更だけ**が違反として観測される。
test("148: entering review re-captures the baseline, so only changes made during review are violations", () => {
  const ctx = makeRoot();
  const git = (...args: string[]) => execFileSync("git", ["-C", ctx.repoRoot, ...args], { stdio: "ignore" });
  const put = (rel: string, body: string) => writeFileSync(path.join(ctx.repoRoot, rel), body, "utf8");

  put("declared.ts", "v1\n");
  put("other.ts", "v1\n");
  git("add", "-A");
  git("commit", "-qm", "seed");

  setStep(ctx.root, "implementation");
  writeIn(
    ctx.root,
    "context-package.md",
    [
      "# Task Summary",
      "s",
      "# Source Requirements",
      "r",
      "# Constraints",
      "c",
      "# Files",
      "## Read",
      "- `x`",
      "## Modify",
      "- `declared.ts`",
      "## Reference",
      "- `x`",
      "## Ignore",
      "- `x`",
      "# Acceptance Criteria Matrix",
      "m",
      "# Test Strategy",
      "t",
      ""
    ].join("\n")
  );
  writeIn(ctx.root, "current-result.md", validResult);
  writeStatus(ctx.root, { step: "implementation", result: "implemented", reason: "x" });
  captureIfAbsent(ctx.root, ctx.config, { step: "implementation", fixAttempts: 0 });

  // implementation の正当な変更
  put("declared.ts", "v2 by implementation\n");

  const outcome = runStep(ctx.root, ctx.config, "implementation");
  assert.equal(outcome.kind, "transitioned");
  assert.equal((outcome as any).to, "review");

  const check = () =>
    runValidators(ctx.root, ctx.config, ctx.config.steps["review"].validators!, { stepId: "review", fixAttempts: 0 })
      .results.find((r) => r.type === "diff-scope")!;

  // 入場直後: implementation の変更は baseline へ吸収済み → 違反ゼロ
  const clean = check();
  assert.equal(clean.status, "passed", `review 入場で取り直していれば passed（実際: ${clean.message}）`);

  // 故障注入 #2: review 中にリポジトリが変わった（すり抜け or 人間の並走作業）
  put("other.ts", "touched during review\n");
  const dirty = check();
  assert.equal(dirty.status, "failed", "検出はする");
  assert.match(dirty.message ?? "", /other\.ts/);
  // ⚠️ **halt しない。** review 中の変更が review の仕業とは限らない（人間の VS・並走ビルド）。
  // report として scope-violation-report.md 経由で承認ゲート③の人間に届く。
  assert.equal(
    ctx.config.steps["review"].validators!.find((v) => v.type === "diff-scope")!.onViolation,
    "report"
  );

  // ⚠️ **残る盲点（BL-115）**: Modify 宣言済みファイルへの変更は違反にならない。
  // ここは validator を変えないと直せないので、**第1網が塞ぐ**という関係をテストにも残す。
  put("declared.ts", "touched during review\n");
  assert.equal(
    /declared\.ts/.test(check().message ?? ""),
    false,
    "宣言済みファイルは第2網に映らない（だから第1網が主）"
  );
});

// Test 149 — review-audit の model-change トリガー（課題G）。**宣言だけの機構にしない。**
test("149: a change of executor or model for review suggests an audit, exactly once", () => {
  const { root, config } = makeRoot();
  const runOf = (executor: string, model: string) =>
    appendEvent(root, "exec.completed", { step: "review", executor, meta: { executor, modelRequested: model } });

  // 記録が1件しかない = 初回。**「不明」を「変わった」へ倒さない**
  runOf("clipboard", "unspecified");
  assert.equal(suggestAuditOnModelChange(root, config, "review"), null);

  // executor が変わった → 提案する
  runOf("claude", "claude-opus-5");
  const suggestion = suggestAuditOnModelChange(root, config, "review");
  assert.ok(suggestion, "review の executor 化はモデル変更そのもの");
  assert.equal(suggestion!.trigger, "model-change");
  assert.deepEqual(suggestion!.previous, { executor: "clipboard", model: "unspecified" });
  assert.deepEqual(suggestion!.current, { executor: "claude", model: "claude-opus-5" });
  // 提案は Event Log にも残る（画面に出ただけで消えると、後から辿れない）
  assert.match(readFileSync(path.join(root, "runs", "execution-log.jsonl"), "utf8"), /"audit\.suggested"/);

  // 同じ実行系が続く間は鳴らない
  runOf("claude", "claude-opus-5");
  assert.equal(suggestAuditOnModelChange(root, config, "review"), null);

  // モデルだけ変えても鳴る
  runOf("claude", "claude-sonnet-5");
  assert.equal(suggestAuditOnModelChange(root, config, "review")?.current.model, "claude-sonnet-5");

  // ⚠️ **宣言が無ければ何もしない。** auditPolicy を読まずに常時鳴らす機構にしない
  const noPolicy = { ...config, auditPolicy: { alsoSuggestOn: ["monthly"] } };
  assert.equal(suggestAuditOnModelChange(root, noPolicy, "review"), null);
});

// Test 150 — 第2網は **assets にも配る**（executor の宣言と違い、環境依存ではない）。
//
// 塞ぐ故障モードが executor 経路の外にあるため: clipboard 運用で人間や対話AIが誤って
// コードを直す形は、`aiw init` で配られた先でも起きる。
test("150: the shipped workflow declares review's second net, but not the executor", () => {
  // makeRoot は assets から init するので、ここで見えるのは**出荷する宣言そのもの**（test 88 と同じ手）。
  const { config: shipped } = makeRoot();
  const review = shipped.steps["review"];

  assert.ok(
    review.validators?.some((v) => v.type === "diff-scope" && v.onViolation === "report"),
    "第2網は出荷する既定に含める"
  );
  assert.equal(review.executor, "clipboard", "executor は環境依存（隔離 home と認証が要る）ので配らない");
  assert.equal(review.bashAllow, undefined, "許可コマンドはプロジェクト固有なので配らない");
  // Skill を更新したら版も上げる（Event Log にどの版で走ったかが残る）
  assert.equal((shipped.versions?.skills as Record<string, number>)?.review, 5, "skills.review の bump 反映");
  // ⚠️ **この数字は意図的な bump のたびに動く。**
  // 契約は「値」ではなく「SKILL.md と versions が同じコミットで動く」こと。
  // ここが落ちたら、bump の反映漏れかを確かめてから更新する。
});

// Test 151 — 故障注入 #10: reflection の許可セット（**自動化しないが、設定は今のうちに固定する**）。
//
// reflection は M4 では clipboard のまま（承認ゲートが無い唯一の Claude ステップで、
// 失敗が知識ファイルを静かに汚染するため・設計 課題C）。将来 executor 化するときに
// 「Bash が無い」「Edit は知識ファイルだけ」が宣言から導かれることをここで固定しておく。
test("151: reflection would get no shell at all, and edit only the knowledge files it declares", () => {
  const { root, config } = makeRoot();
  const step = config.steps["reflection"];

  // bashAllow を宣言していない = **Bash はツール集合ごと渡らない**
  assert.equal(step.bashAllow, undefined);
  assert.equal(toolSet(step), "Read,Grep,Glob,Edit", "シェルを持たない");

  const rules = allowRules(root, step);
  assert.equal(rules.some((r) => r.startsWith("Bash(")), false);

  const edits = rules.filter((r) => r.startsWith("Edit("));
  const named = edits.map((r) => r.replace(/^Edit\(|\)$/g, "").split("/").pop());
  // 宣言した outputs / optionalOutputs だけ。**リポジトリ側は1本も無い**
  assert.deepEqual(
    [...named].sort(),
    ["**", "backlog.md", "context.md", "current-status.json", "learnings.md", "task-metadata.json"].sort()
  );
  // ↑ の '**' は research/ 。**唯一グロブが要る宣言**（設計 課題B の表）で、
  // ディレクトリ宣言を**静かに落とさず**範囲をそのディレクトリへ閉じていることを見る。
  assert.ok(
    edits.some((r) => /Edit\(\/\/[a-z]\/.*\/research\/\*\*\)$/.test(r)),
    "research/ はその配下に限ったグロブになる"
  );
});
