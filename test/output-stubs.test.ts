// 0 バイトスタブ（M4 段階1-3・設計 課題B「Edit-only の存在要求」）。
//
// claude executor は `Edit` でしか書けず（`Write` はパスルールが効かないので渡していない）、
// **Edit は対象ファイルの存在を要求する**。`aiw init` 直後の環境には
// `context-package.md` / `codex-prompt.md` が無いので、エージェントは書けずに
// **exit 0 で終わる**（実測）。存在はエンジンが保証し、中身の検証は contract が担う。
//
// ここで固定するのは「作る」ことより **作り方の規律**:
//   - 既存は絶対に上書きしない（reject → rerun で書いた成果物を消さない）
//   - 0 バイトは file-exists を通すが **contract で必ず止まる**（素通りしない）
//   - 必要な範囲にだけ作る（reflection の task-metadata.json の網を弱めない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { approve, runStep } from "../src/engine/engine.js";
import { rootPaths } from "../src/engine/paths.js";
import { runValidators } from "../src/engine/validators.js";
import type { WorkflowConfig } from "../src/engine/types.js";
import { makeRoot, setStep, validResult, validContextPackage, writeIn, writeStatus } from "./helpers.js";

/** research を claude 実行にした config（runtime の段階1-3 相当）。assets は clipboard のまま。 */
function withClaudeResearch(config: WorkflowConfig): WorkflowConfig {
  return { ...config, steps: { ...config.steps, research: { ...config.steps.research, executor: "claude" } } };
}

function lastEvent(root: string, type: string): any {
  const lines = readFileSync(rootPaths(root).eventLog, "utf8").trim().split("\n").filter(Boolean);
  const hit = lines.map((l) => JSON.parse(l)).filter((r) => r.event === type);
  return hit[hit.length - 1];
}

/** task-planning を通過させて research へ入る（遷移確定のフックを本物で踏む）。 */
function enterResearch(config: WorkflowConfig) {
  const { root } = makeRoot();
  setStep(root, "task-planning");
  writeStatus(root, { step: "task-planning", result: "planned", reason: "x" });
  writeIn(
    root,
    "current-task.md",
    ["# Task", "## Goal", "g", "## Scope", "- s", "## Requirements", "- r", "## Out of Scope", "- o", "## Acceptance Criteria", "- a", ""].join("\n")
  );
  const first = runStep(root, config, "task-planning");
  assert.equal(first.kind, "awaiting-approval", "承認ゲート①");
  const outcome = approve(root, config);
  assert.equal((outcome as any).to, "research");
  return root;
}

// Test 155 — 入場時に**足りないものだけ** 0 バイトで作り、作ったことを記録する。
test("155: entering a claude-run step creates empty stubs for the missing outputs, and records what it made", () => {
  const config = withClaudeResearch(makeRoot().config);
  const root = enterResearch(config);

  // research の必須成果物 4 本のうち、init 直後に無いのは下の 3 本
  // （current-status.json は前ステップの宣言が残っている）
  for (const f of ["context-package.md", "codex-prompt.md", "research-findings.md"]) {
    const file = path.join(root, f);
    assert.ok(existsSync(file), `${f} が無いと Edit は書けない`);
    assert.equal(statSync(file).size, 0, "**0 バイト**（テンプレートを置かない）");
  }

  const ev = lastEvent(root, "stub.created");
  assert.ok(ev, "黙って作らない");
  assert.deepEqual([...ev.files].sort(), ["codex-prompt.md", "context-package.md", "research-findings.md"]);
  // ⚠️ `research-findings.md` が入るのは **`aiw init` 直後だけ**（以降は restoreTemplates が戻す）。
  // そしてそのテンプレートは必須 8 見出しを備えていて **contract を自力で満たす**（BL-116）。
  // つまりここでの 0 バイトは、init 直後に限っては BL-116 の穴より**厳しい**側に倒れている。
  assert.equal(ev.step, "research");
});

// Test 156 — **既存は上書きしない。** reject → rerun の窓で書き上げた成果物を消さない。
test("156: an artifact that already exists is never overwritten by a stub", () => {
  const config = withClaudeResearch(makeRoot().config);
  const { root } = makeRoot();
  setStep(root, "task-planning");
  writeStatus(root, { step: "task-planning", result: "planned", reason: "x" });
  writeIn(
    root,
    "current-task.md",
    ["# Task", "## Goal", "g", "## Scope", "- s", "## Requirements", "- r", "## Out of Scope", "- o", "## Acceptance Criteria", "- a", ""].join("\n")
  );
  // 前回の research が書いた本文が残っている状態
  const body = validContextPackage();
  writeIn(root, "context-package.md", body);

  runStep(root, config, "task-planning");
  approve(root, config);

  assert.equal(readFileSync(path.join(root, "context-package.md"), "utf8"), body, "1バイトも触らない");
  assert.equal(statSync(path.join(root, "codex-prompt.md")).size, 0, "無い方だけ作る");
  const made = lastEvent(root, "stub.created").files;
  assert.equal(made.includes("context-package.md"), false, "既にあるものは記録にも出ない");
  assert.deepEqual([...made].sort(), ["codex-prompt.md", "research-findings.md"], "作った分だけを記録する");
});

// Test 157 — **0 バイトは素通りしない。** file-exists は通るが contract が止める。
//
// ⚠️ これが「テンプレート復元ではなく 0 バイト」を選んだ理由そのもの。
// テンプレートは必須見出しを備えているので `artifact-contract` を**自力で満たしてしまう**
// （`codex-prompt.md` には token-range が無いので、書かれなくても通ってしまう）。
test("157: an empty stub passes file-exists but is stopped by the contract, so nothing slips through", () => {
  const config = withClaudeResearch(makeRoot().config);
  const root = enterResearch(config);
  writeStatus(root, { step: "research", result: "research-complete", reason: "書いたつもり" });

  const results = runValidators(root, config, config.steps["research"].validators!, {
    stepId: "research",
    fixAttempts: 0
  }).results;

  const byType = (t: string) => results.filter((r) => r.type === t);
  assert.equal(byType("file-exists")[0].status, "passed", "存在は満たされている（Edit の前提）");
  assert.ok(
    byType("artifact-contract").some((r) => r.status === "failed"),
    "**見出しが無いので落ちる**——安全網は減っていない、担当が移っただけ"
  );

  const outcome = runStep(root, config, "research");
  assert.equal(outcome.kind, "halted", "空のまま先へは進めない");
});

// Test 158 — **必要な範囲にだけ作る。** clipboard / codex のステップには作らない。
//
// ⚠️ 全ステップで作ると `reflection` の `task-metadata.json` に 0 バイトが置かれ、
// 「毎回新しく書かせるために消す」（`discardTaskMetadata`）の意図を骨抜きにする。
// 今日の `file-exists` は**ファイル名を挙げて**止めるが、スタブがあると理由が
// 「JSON として壊れている」へ落ちる。存在を要求しているのは Edit だけなので、そこに限る。
test("158: steps that are not run by claude get no stubs, so the file-exists net keeps its wording", () => {
  const { root, config } = makeRoot(); // 素の config = 全ステップ clipboard
  setStep(root, "implementation");
  writeIn(root, "context-package.md", validContextPackage());
  writeIn(root, "current-result.md", validResult);
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });
  rmSync(path.join(root, "task-metadata.json"), { force: true });

  const outcome = runStep(root, config, "implementation");
  assert.equal(outcome.kind, "transitioned");
  assert.equal((outcome as any).to, "review");

  // review は clipboard（assets の既定）なので、その outputs にスタブは作られない
  assert.equal(existsSync(path.join(root, "task-metadata.json")), false, "reflection の網を弱めない");
  assert.equal(lastEvent(root, "stub.created"), undefined, "作っていないので記録も無い");
});
