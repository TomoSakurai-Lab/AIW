// diff-scope 故障注入テスト（設計 docs/design-diff-scope.md 課題3 のシナリオ1〜8 + 追加ケース）。
//
// 作って終わりにしない。壊して期待どおり止まることを確認するまでが M1.5。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runStep } from "../src/engine/engine.js";
import { captureIfAbsent, readBaseline } from "../src/engine/gitScope.js";
import { runValidators, type ValidationOutcome } from "../src/engine/validators.js";
import { makeRoot, setStep, validResult, writeIn, writeStatus } from "./helpers.js";

// ---- 検査対象リポジトリの操作 ----

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function put(repo: string, rel: string, body: string): void {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

const PKG = (modify: string[]): string =>
  [
    "# Task Summary",
    "t",
    "# Source Requirements",
    "r",
    "# Constraints",
    "c",
    "# Files",
    "## Read",
    "- `declared.ts`",
    "## Modify",
    ...modify.map((m) => `- \`${m}\``),
    "## Reference",
    "- x",
    "## Ignore",
    "- .ai-workflow2/",
    "# Acceptance Criteria Matrix",
    "| ID | Expected Behavior | Verification | Evidence Required |",
    "|---|---|---|---|",
    "| AC-01 | a | t | n |",
    "# Test Strategy",
    "ts",
    ""
  ].join("\n");

const REVIEW = (modify: string[]): string =>
  [
    "# Summary",
    "s",
    "## Specification Coverage Audit",
    "a",
    "## Acceptance Criteria Evidence Audit",
    "a",
    "## Manual Verification Audit",
    "a",
    "## Risk Area Audit",
    "a",
    "## Critical",
    "c",
    "## Major",
    "m",
    "## Minor",
    "mi",
    "## Good",
    "g",
    "## Backlog",
    "b",
    "## Ready",
    "r",
    "## Verification Data",
    "v",
    "## Fix Scope",
    "### Files To Modify",
    ...modify.map((m) => `- \`${m}\``),
    "### Critical",
    "c",
    "### Major",
    "m",
    "### Acceptance Criteria",
    "a",
    "### Test Required",
    "t",
    ""
  ].join("\n");

/** implementation を検査可能な状態にする（baseline 取得まで） */
function arrangeImplementation(modify: string[] = ["declared.ts"]) {
  const ctx = makeRoot();
  put(ctx.repoRoot, "declared.ts", "v1\n");
  put(ctx.repoRoot, "other.ts", "v1\n");
  git(ctx.repoRoot, "add", "-A");
  git(ctx.repoRoot, "commit", "-qm", "seed");

  setStep(ctx.root, "implementation");
  writeIn(ctx.root, "context-package.md", PKG(modify));
  writeIn(ctx.root, "current-result.md", validResult);
  writeStatus(ctx.root, { step: "implementation", result: "implemented", reason: "x" });
  return ctx;
}

function capture(ctx: ReturnType<typeof makeRoot>, step: string, fixAttempts: number) {
  return captureIfAbsent(ctx.root, ctx.config, { step, fixAttempts });
}

function validate(ctx: ReturnType<typeof makeRoot>, step: string, fixAttempts: number): ValidationOutcome {
  return runValidators(ctx.root, ctx.config, ctx.config.steps[step].validators!, { stepId: step, fixAttempts });
}

function diffScope(outcome: ValidationOutcome) {
  return outcome.results.find((r) => r.type === "diff-scope")!;
}

// ---------------------------------------------------------------------------

// #1 開始前から無関係な未コミット変更が多数 → 違反にしない
test("59 (#1): pre-existing dirty files are never violations", () => {
  const ctx = arrangeImplementation();
  for (let i = 0; i < 12; i++) {
    put(ctx.repoRoot, `wip-${i}.ts`, "human work in progress\n");
  }
  put(ctx.repoRoot, "other.ts", "human edit before the task\n");
  assert.equal(capture(ctx, "implementation", 0).kind, "captured");

  put(ctx.repoRoot, "declared.ts", "codex edit\n"); // 宣言内だけ触る
  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "passed", r.message);
  assert.match(r.message, /checked /, "検査範囲は常に出す");
});

// #2 宣言外のファイルを新規作成 → 違反
test("60 (#2): creating an undeclared file is a violation", () => {
  const ctx = arrangeImplementation();
  capture(ctx, "implementation", 0);
  put(ctx.repoRoot, "src/sneaky.ts", "codex created this\n");

  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "failed");
  assert.match(r.message, /src\/sneaky\.ts/);
});

// #3 宣言外の既存ファイルを編集 → 違反
test("61 (#3): editing an undeclared tracked file is a violation", () => {
  const ctx = arrangeImplementation();
  capture(ctx, "implementation", 0);
  put(ctx.repoRoot, "other.ts", "codex edited this\n");

  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "failed");
  assert.match(r.message, /other\.ts/);
});

// #4 タスク中に無関係ファイルを編集 → 違反（人間か Codex かは判別不能）
// #7 既 dirty ファイルをさらに編集 → 違反 + 確度注記
test("62 (#4,#7): changes to already-dirty files are violations with a confidence note", () => {
  const ctx = arrangeImplementation();
  put(ctx.repoRoot, "other.ts", "human wip\n"); // baseline 時点で既に dirty
  capture(ctx, "implementation", 0);

  put(ctx.repoRoot, "other.ts", "human wip + more\n"); // タスク中にさらに変更
  const r = diffScope(validate(ctx, "implementation", 0));

  assert.equal(r.status, "failed");
  assert.match(r.message, /already modified at baseline time/, "帰属不能であることを明示する");
  const detail = r.detail as { violations: Array<{ path: string; kind: string }> };
  assert.equal(detail.violations[0].kind, "modified-since");
});

// #5 日跨ぎ相当（capturedAt が古い）→ 違反 + capturedAt 併記
test("63 (#5): an old baseline still checks, and the report carries capturedAt", () => {
  const ctx = arrangeImplementation();
  capture(ctx, "implementation", 0);

  // capturedAt を1週間前へ書き換える（日跨ぎ相当）
  const file = path.join(ctx.root, "runs", "baseline.json");
  const b = JSON.parse(readFileSync(file, "utf8"));
  b.capturedAt = "2026-07-29T00:00:00.000Z";
  writeFileSync(file, JSON.stringify(b, null, 2), "utf8");

  put(ctx.repoRoot, "other.ts", "changed a week later\n");
  const r = diffScope(validate(ctx, "implementation", 0));

  assert.equal(r.status, "failed");
  assert.match(r.message, /2026-07-29/, "capturedAt を併記して人間が古さを判断できるようにする");
});

// #6 タスク中にコミット（HEAD 移動）→ 警告のみ、違反にしない
test("64 (#6): a commit during the task is a note, not a violation", () => {
  const ctx = arrangeImplementation();
  put(ctx.repoRoot, "other.ts", "human wip\n");
  capture(ctx, "implementation", 0);

  git(ctx.repoRoot, "add", "-A");
  git(ctx.repoRoot, "commit", "-qm", "human commits their own work");

  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "passed", r.message);
  assert.match(r.message, /HEAD moved since baseline/, "HEAD 移動は参考情報として必ず出す");
});

// #8 ビルド生成物 / ignore 済み → 違反にしない
test("65 (#8): ignored build output is never a violation", () => {
  const ctx = arrangeImplementation();
  put(ctx.repoRoot, ".gitignore", [".ai-workflow2/", "dist/", "node_modules/", ""].join("\n"));
  git(ctx.repoRoot, "add", "-A");
  git(ctx.repoRoot, "commit", "-qm", "ignore build output");
  capture(ctx, "implementation", 0);

  put(ctx.repoRoot, "dist/bundle.js", "generated\n");
  put(ctx.repoRoot, "node_modules/x/index.js", "dep\n");
  put(ctx.repoRoot, "declared.ts", "codex edit\n");

  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "passed", r.message);
});

// #9 baseline が無い（implementation）→ skipped + skipReason
test("66 (#9): a missing baseline on implementation is skipped, not passed", () => {
  const ctx = arrangeImplementation();
  assert.equal(readBaseline(ctx.root), null, "capture していない");

  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "skipped", "report 宣言なので「違反あり」と偽らない");
  assert.match(r.skipReason ?? "", /no baseline/);
  assert.match(r.message, /checked /, "検査範囲は skipped でも出す");
});

// #10 baseline が無い（fix）→ failed → halt
test("67 (#10): a missing baseline on fix halts", () => {
  const ctx = arrangeImplementation();
  setStep(ctx.root, "fix", { fixAttempts: 1 });
  writeIn(ctx.root, "current-review.md", REVIEW(["declared.ts"]));
  writeStatus(ctx.root, { step: "fix", result: "fixed", reason: "x" });

  const outcome = validate(ctx, "fix", 1);
  assert.equal(diffScope(outcome).status, "failed", "halt 宣言の validator が skipped で素通りしない");
  assert.equal(outcome.halt, true);

  const out = runStep(ctx.root, ctx.config, "fix");
  assert.equal(out.kind, "halted");
  assert.equal(out.kind === "halted" && out.reason, "validation-failed");
});

// #11 宣言源の見出しが欠落 → failed（skipped にしない）
test("68 (#11): a missing declaration heading fails, it does not skip", () => {
  const ctx = arrangeImplementation();
  capture(ctx, "implementation", 0);
  // `## Modify` を落とした context-package.md
  writeIn(ctx.root, "context-package.md", "# Files\n\n## Read\n- `a.ts`\n");

  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "failed", "契約が保証するはずの構造欠落は「検査できなかった」ではない");
  assert.match(r.message, /has no "## Modify" section/);
});

// #12 見出しはあるが項目ゼロ → 宣言ゼロとして扱い、変更があれば違反
test("69 (#12): an empty declaration means zero declarations, not skip-the-check", () => {
  const ctx = arrangeImplementation([]); // ## Modify が空
  capture(ctx, "implementation", 0);
  put(ctx.repoRoot, "declared.ts", "something changed anyway\n");

  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "failed", "「何も変更しないはずなのに変わった」を検出する");
  assert.match(r.message, /declared\.ts/);
});

// #13 resume を2回 → baseline が再取得されない（罠1・最重要）
test("70 (#13): resuming twice never re-captures the baseline", () => {
  const ctx = arrangeImplementation();
  assert.equal(capture(ctx, "implementation", 0).kind, "captured");
  const first = readBaseline(ctx.root)!;

  // Codex が宣言外のファイルを作る
  put(ctx.repoRoot, "leaked.ts", "codex went outside\n");

  // resume 相当を2回。captureIfAbsent は同一キーでは取り直さない
  assert.equal(capture(ctx, "implementation", 0).kind, "already-current");
  assert.equal(capture(ctx, "implementation", 0).kind, "already-current");

  const after = readBaseline(ctx.root)!;
  assert.equal(after.capturedAt, first.capturedAt, "baseline は取り直されていない");
  assert.deepEqual(
    after.dirty.map((d) => d.path),
    first.dirty.map((d) => d.path),
    "Codex の変更が baseline へ吸収されていない"
  );

  // 検査は依然として違反を検出する（=無効化されていない）
  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "failed");
  assert.match(r.message, /leaked\.ts/);
});

// #14 checkRepoRoot で git が失敗 → implementation: skipped / fix: failed
test("71 (#14): an unresolvable checkRepoRoot skips on report and fails on halt", () => {
  const ctx = arrangeImplementation();
  const broken = { ...ctx.config, settings: { ...ctx.config.settings, repoRoot: path.join(ctx.repoRoot, "nope") } };

  const impl = runValidators(ctx.root, broken, ctx.config.steps["implementation"].validators!, {
    stepId: "implementation",
    fixAttempts: 0
  });
  assert.equal(diffScope(impl).status, "skipped");
  assert.match(diffScope(impl).skipReason ?? "", /checkRepoRoot could not be resolved/);

  writeIn(ctx.root, "current-review.md", REVIEW(["declared.ts"]));
  writeStatus(ctx.root, { step: "fix", result: "fixed", reason: "x" });
  const fix = runValidators(ctx.root, broken, ctx.config.steps["fix"].validators!, { stepId: "fix", fixAttempts: 1 });
  assert.equal(diffScope(fix).status, "failed");
  assert.equal(fix.halt, true);
});

// #15 検査対象で1ファイルも変更が観測されない → 「違反なし」とは別の文面にする
//
// 宣言があるのに変更 0 件は正常系ではまず起きない。起きるとすれば repoRoot が違う /
// Codex が何もしなかった / 検査対象外の場所に書いた のいずれかで、どれも人間が知るべき状態。
// 無人運転では誰もメッセージを読まないので、文面を分けておくことが唯一の手がかりになる。
test("72 (#15): observing no changes at all is worded differently from a clean pass", () => {
  const ctx = arrangeImplementation();
  capture(ctx, "implementation", 0);
  // 何も変更しない（repoRoot 取り違えの再現）

  const r = diffScope(validate(ctx, "implementation", 0));
  assert.equal(r.status, "passed");
  assert.match(r.message, /no changes observed in the checked repository/);
  assert.match(r.message, /verify repoRoot if unexpected/);
  assert.doesNotMatch(r.message, /no changes outside the declaration/, "「違反なし」と同じ文面にしない");

  // 対照: 宣言内の変更が実在すれば通常の pass 文面になる
  put(ctx.repoRoot, "declared.ts", "codex edit\n");
  const ok = diffScope(validate(ctx, "implementation", 0));
  assert.match(ok.message, /no changes outside the declaration/);
  assert.doesNotMatch(ok.message, /no changes observed/);
});

// scope-violation-report.md の生成と、古いレポートの掃除
test("73: scope-violation-report.md is written on report and removed when clean", () => {
  const ctx = arrangeImplementation();
  capture(ctx, "implementation", 0);
  put(ctx.repoRoot, "other.ts", "outside the declaration\n");

  const report = path.join(ctx.root, "scope-violation-report.md");
  const out = runStep(ctx.root, ctx.config, "implementation");
  assert.equal(out.kind, "transitioned", "implementation は report なので止まらない");
  assert.ok(existsSync(report), "review の入力として書き出す");

  const body = readFileSync(report, "utf8");
  assert.match(body, /# Scope Violation Report/);
  assert.match(body, /other\.ts/);
  assert.match(body, /## Checked Repository/, "検査範囲をレポートにも書く");

  // 違反が解消したら消す。残っていると review が解決済みの違反を現在のものとして読む
  rmSync(path.join(ctx.repoRoot, "other.ts"));
  git(ctx.repoRoot, "checkout", "--", "other.ts");
  setStep(ctx.root, "implementation");
  writeStatus(ctx.root, { step: "implementation", result: "implemented", reason: "x" });
  runStep(ctx.root, ctx.config, "implementation");
  assert.equal(existsSync(report), false, "古いレポートは残さない");
});
