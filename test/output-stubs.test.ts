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
import { approve, execStep, runStep } from "../src/engine/engine.js";
import type { StepExecutor } from "../src/engine/executors/types.js";
import { rootPaths } from "../src/engine/paths.js";
import { runValidators } from "../src/engine/validators.js";
import type { WorkflowConfig } from "../src/engine/types.js";
import { makeRoot, setStep, validResult, validContextPackage, validTask, writeIn, writeStatus } from "./helpers.js";

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
    validTask /* 小枠B: 整形契約を満たす形 */
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
  // そしてそのテンプレートは必須 8 見出しを備えていて **contract を自力で満たす**（BL-213）。
  // つまりここでの 0 バイトは、init 直後に限っては BL-213 の穴より**厳しい**側に倒れている。
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
    validTask /* 小枠B: 整形契約を満たす形 */
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

/** 起動された瞬間に、指定したファイルがあったか・何バイトだったかを記録するだけの executor（claude を名乗る）。 */
function probeExecutor(root: string, files: string[]): { executor: StepExecutor; seen: Record<string, number | null> } {
  const seen: Record<string, number | null> = {};
  const executor: StepExecutor = {
    name: "claude",
    async execute() {
      for (const f of files) {
        const file = path.join(root, f);
        seen[f] = existsSync(file) ? statSync(file).size : null;
      }
      return { ok: true, outputs: [] };
    }
  };
  return { executor, seen };
}

function withClaudePlanning(config: WorkflowConfig): WorkflowConfig {
  return { ...config, steps: { ...config.steps, "task-planning": { ...config.steps["task-planning"], executor: "claude" } } };
}

// Test 294 — **遷移を経ずに claude のステップへ来ても、起動の前にスタブがある。**
//
// 実測 2026-10-27（本番 tokyu への移植）: `aiw init` は assets の設定（task-planning は clipboard）で入場するのでスタブを作らない。
// その後 runtime の設定（task-planning は claude）へ差し替えて `aiw exec task-planning` したところ、
// current-status.json が無いまま claude が起動し、Edit で書けずに終わって file-exists で halt した。
// exec の直前にも同じ関数で作る。既存は上書きしない・clipboard では作らない（Test 155-158 の規律のまま）。
test("294: exec creates the missing stubs before launching a claude step that was never entered by a transition", async () => {
  {
    const { root, config } = makeRoot(); // aiw init 直後 = task-planning・current-status.json なし
    assert.equal(existsSync(path.join(root, "current-status.json")), false, "前提: init はスタブを作っていない");
    const claude = withClaudePlanning(config);
    const { executor, seen } = probeExecutor(root, ["current-status.json", "current-task.md"]);

    await execStep(root, claude, "task-planning", { executor });

    assert.equal(seen["current-status.json"], 0, "起動の時点で 0 バイトのスタブがある（無いと Edit は書けない）");
    assert.ok((seen["current-task.md"] ?? 0) > 0, "テンプレートから置かれた current-task.md は上書きしない");
    const ev = lastEvent(root, "stub.created");
    assert.equal(ev.step, "task-planning");
    assert.equal(ev.via, "exec");
    assert.deepEqual(ev.files, ["current-status.json"]);
    assert.equal(JSON.parse(readFileSync(rootPaths(root).stateFile, "utf8")).currentStep, "task-planning", "exec は state を進めない");
  }
  {
    // 既にある宣言は消さない（書きかけ・前ステップの宣言は run 側の検査が扱う）
    const { root, config } = makeRoot();
    writeStatus(root, { step: "task-planning", result: "planned", reason: "書きかけ" });
    const before = readFileSync(path.join(root, "current-status.json"), "utf8");
    const { executor } = probeExecutor(root, []);
    await execStep(root, withClaudePlanning(config), "task-planning", { executor });
    assert.equal(readFileSync(path.join(root, "current-status.json"), "utf8"), before);
    assert.equal(lastEvent(root, "stub.created"), undefined, "作っていないので記録も無い");
  }
  {
    // clipboard のステップには作らない（「まだ誰も宣言していない」を保つ）
    const { root, config } = makeRoot();
    const { executor } = probeExecutor(root, []);
    await execStep(root, config, "task-planning", { executor });
    assert.equal(existsSync(path.join(root, "current-status.json")), false);
  }
});
