// BL-392（2026-11-06）: 人が書く入力（inputs の `humanInput: true`）がテンプレートのままなら、claude / codex のステップを起動しない。
//
// 実測（10-23 12:13 / 10-26 03:00）: drive の「新しいタスクを始めますか？」に y と答えた直後に、テンプレートのままの user-task.md で
// task-planning を claude で起動し、何も書かれずに current-status.json の空で halt した（4 件）。task-planning を auto の区間へ入れると、
// この経路が人の確認なしで毎回起きる。
//   - exec: executor を呼ばずに拒否（state・スタブに触らない・exec.refused を残す）。clipboard は見ない（不変条件5）
//   - auto: exec の前に同じ判定で、人の作業待ち A27（終了コード 0・drive へ戻る）
//   - drive: 人の作業待ち（A26 / A27）で戻ったら人に聞く。聞かずに戻ると同じステップで auto を再起動し続ける（空回り）
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AUTO_EXIT, deriveAutoBudget, returnsToDrive, returnToDriveLine, runAuto } from "../src/engine/auto.js";
import { EngineError, execStep, loadConfig, resetForNewTask, UnfilledInputError } from "../src/engine/engine.js";
import type { StepExecutor } from "../src/engine/executors/types.js";
import { loadWorkflow } from "../src/engine/loader.js";
import { rootPaths } from "../src/engine/paths.js";
import type { WorkflowConfig } from "../src/engine/types.js";
import { makeRoot, setStep, writeIn } from "./helpers.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST = "# User Task\n\n- 一覧の列幅を揃える\n";

function events(root: string, type: string): any[] {
  const file = rootPaths(root).eventLog;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.event === type);
}

function stateText(root: string): string {
  return readFileSync(rootPaths(root).stateFile, "utf8");
}

/** 呼ばれたことだけを記録する偽の executor（成果物は書かない） */
function probe(): { executor: StepExecutor; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    executor: {
      name: "claude",
      async execute(req) {
        calls.push(req.step.id);
        return { ok: true, outputs: [] };
      }
    }
  };
}

function planningAs(config: WorkflowConfig, patch: Record<string, unknown>): WorkflowConfig {
  return { ...config, steps: { ...config.steps, "task-planning": { ...config.steps["task-planning"], ...patch } } };
}

// Test 296 — exec の拒否。テンプレートのまま・無い・改行や BOM や行末の空白だけ違う → 拒否。書いてあれば起動する。clipboard は見ない
test("296: exec refuses a claude / codex step while a humanInput is still the template, without touching state or stubs", async () => {
  const { root, config } = makeRoot();
  assert.equal(config.steps["task-planning"].inputs.find((r) => r.path === "user-task.md")?.humanInput, true, "出荷する設定が宣言している");
  const claude = planningAs(config, { executor: "claude" });
  // 出荷するテンプレートは CRLF。変種は LF へ揃えてから作る（CRLF のまま \n を置き換えると \r\r\n になり、別の内容になる）
  const template = readFileSync(path.join(rootPaths(root).templatesDir, "user-task.md"), "utf8").replace(/\r\n/g, "\n");

  // (1) テンプレートのまま → executor を呼ばない・state もスタブも触らない・記録が残る
  {
    const before = stateText(root);
    const { executor, calls } = probe();
    await assert.rejects(
      () => execStep(root, claude, "task-planning", { executor }),
      (e: Error) => e instanceof UnfilledInputError && e instanceof EngineError && /user-task\.md（テンプレートのまま）/.test(e.message)
    );
    assert.deepEqual(calls, [], "executor を呼ばない");
    assert.equal(stateText(root), before, "state は変わらない（不変条件1）");
    assert.equal(existsSync(path.join(root, "current-status.json")), false, "スタブも作らない（起動しないので）");
    assert.equal(events(root, "exec.started").length, 0);
    const ev = events(root, "exec.refused").at(-1);
    assert.equal(ev.step, "task-planning");
    assert.equal(ev.reason, "unfilled-human-input");
    assert.deepEqual(ev.unfilled, [{ path: "user-task.md", reason: "template" }]);
  }

  // (2) エディタで開いて保存しただけ（CRLF・BOM・行末の空白・末尾の空行）は「書いた」に数えない
  for (const variant of [
    template,
    template.replace(/\n/g, "\r\n"),
    "﻿" + template,
    template.replace(/\n/g, "  \n") + "\n\n"
  ]) {
    writeIn(root, "user-task.md", variant);
    const { executor, calls } = probe();
    await assert.rejects(() => execStep(root, claude, "task-planning", { executor }), UnfilledInputError);
    assert.deepEqual(calls, []);
  }

  // (3) ファイルが無いのも「誰も書いていない」
  rmSync(path.join(root, "user-task.md"));
  await assert.rejects(
    () => execStep(root, claude, "task-planning", { executor: probe().executor }),
    (e: Error) => e instanceof UnfilledInputError && /user-task\.md（ファイルが無い）/.test(e.message)
  );

  // (4) 書いてあれば起動する
  writeIn(root, "user-task.md", REQUEST);
  {
    const { executor, calls } = probe();
    await execStep(root, claude, "task-planning", { executor });
    assert.deepEqual(calls, ["task-planning"]);
  }

  // (5) clipboard は見ない（人が貼る経路・不変条件5）。テンプレートのままでも今までどおり executor を呼ぶ
  {
    const { root: r2, config: c2 } = makeRoot();
    assert.equal(c2.steps["task-planning"].executor, "clipboard", "前提: 雛形は clipboard");
    const { executor, calls } = probe();
    await execStep(r2, c2, "task-planning", { executor });
    assert.deepEqual(calls, ["task-planning"]);
    assert.equal(events(r2, "exec.refused").length, 0);
  }

  // (6) 宣言したのにテンプレートが無い → 比べる相手が無いまま通さない
  {
    const { root: r3, config: c3 } = makeRoot();
    writeIn(r3, "user-task.md", REQUEST);
    rmSync(path.join(rootPaths(r3).templatesDir, "user-task.md"));
    await assert.rejects(
      () => execStep(r3, planningAs(c3, { executor: "claude" }), "task-planning", { executor: probe().executor }),
      /declared humanInput but templates\/user-task\.md does not exist/
    );
  }

  // (7) 書き損じはロード時に落とす（効かないまま黙って通さない）
  {
    const { root: r4 } = makeRoot();
    const file = rootPaths(r4).workflowYaml;
    const original = readFileSync(file, "utf8");
    const doc = parseYaml(original);
    doc.steps["task-planning"].inputs[0].humanInput = "yes";
    writeFileSync(file, stringifyYaml(doc), "utf8");
    assert.throws(() => loadWorkflow(r4), /input "user-task\.md" declares humanInput: "yes"\. Allowed: true or false/);
    const doc2 = parseYaml(original);
    doc2.steps["task-planning"].outputs[0].humanInput = true;
    writeFileSync(file, stringifyYaml(doc2), "utf8");
    assert.throws(() => loadWorkflow(r4), /outputs "current-task\.md" declares humanInput\. It only applies to inputs/);
  }
});

// Test 297 — auto は exec の前に同じ判定で止まる（A27・人の番・終了コード 0）。書いてあれば exec へ進む
// （feature の継続では user-task.md が残るので止まらない——new-task の直後だけが止まる）。予算は task-planning の分だけ増える
test("297: auto pauses as a human turn (A27) before exec while the request is unwritten, and runs task-planning once it is", async () => {
  const { root, config } = makeRoot();
  const cfg = planningAs(config, { executor: "claude", auto: true });

  // (1) new-task の直後（テンプレートへ戻した直後）
  resetForNewTask(root, loadConfig(root));
  const before = stateText(root);
  const { executor, calls } = probe();
  const r = await runAuto(root, cfg, { executor });
  assert.equal(r.condition, "A27");
  assert.equal(r.stop, "awaiting-input");
  assert.equal(r.step, "task-planning");
  assert.equal(r.exitCode, AUTO_EXIT.humanTurn, "エラーではない");
  assert.equal(returnsToDrive(r), true, "drive の auto モードは drive へ戻る");
  assert.match(r.line, /⏸ 人の作業待ち: task-planning — 依頼がまだ書かれていない: user-task\.md（テンプレートのまま）。書いたら aiw auto で再開/);
  assert.equal(returnToDriveLine(r), "↩ task-planning の依頼がまだ書かれていないので drive に戻ります。");
  assert.deepEqual(calls, [], "exec しない");
  assert.equal(stateText(root), before, "state は変わらない");
  assert.deepEqual(events(root, "auto.awaiting-input").at(-1)?.unfilled, [{ path: "user-task.md", reason: "template" }]);
  assert.equal(events(root, "exec.refused").length, 0, "exec まで行かずに止まる（exec の拒否を executor 失敗として受けない）");

  // (2) 依頼を書いたら（= feature の継続で user-task.md が残っている状態と同じ）exec へ進む。成果物を書かない偽物なので、その先は run が止める
  writeIn(root, "user-task.md", REQUEST);
  const second = probe();
  const r2 = await runAuto(root, cfg, { executor: second.executor });
  assert.deepEqual(second.calls, ["task-planning"], "task-planning を exec する");
  assert.notEqual(r2.condition, "A27");

  // (3) 予算: task-planning は承認ゲート①を持つので辺を出さず、導出値は 1 増えるだけ
  const without = deriveAutoBudget(config);
  const withPlanning = deriveAutoBudget(cfg);
  assert.equal(withPlanning.total, without.total + 1);
  assert.deepEqual(withPlanning.breakdown.find((b) => b.step === "task-planning"), { step: "task-planning", count: 1 });
});

/** drive をサブプロセスで動かす（auto.test.ts の driveCli と同じ）。空回りすれば timeout で落ちる */
function driveCli(root: string, input: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [path.join(PKG, "node_modules", "tsx", "dist", "cli.js"), path.join(PKG, "src", "cli.ts"), "--root", root, "drive"],
    { input, encoding: "utf8", windowsHide: true, timeout: 120_000, cwd: PKG }
  );
  assert.equal(r.error, undefined, `aiw drive が終わらない（空回り？）: ${r.error?.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function patchYaml(root: string, patch: (doc: any) => void): void {
  const file = rootPaths(root).workflowYaml;
  const doc = parseYaml(readFileSync(file, "utf8"));
  patch(doc);
  writeFileSync(file, stringifyYaml(doc), "utf8");
}

// Test 298 — drive は人の作業待ち（A27 / A26）で戻ったら聞き、n で終わる。**聞かずに同じステップで auto を再起動し続けない。**
// 手で y を選んで exec が断ったときも、run へ進めるか（「成果物を確認したら y」）は聞かずに選び直させる
// ⚠️ どの経路も executor の起動より前で止まるので、実物の claude / codex は起動しない
test("298: drive asks after a human-work pause (A27 / A26) instead of relaunching auto, and a refused manual exec does not ask to run", () => {
  // (1) A27: a で auto に入る → 依頼が未記入で止まる → 聞く → n で終わる
  {
    const { root } = makeRoot();
    patchYaml(root, (doc) => {
      doc.steps["task-planning"].executor = "claude";
      doc.steps["task-planning"].auto = true;
    });
    const out = driveCli(root, "a\nn\n");
    assert.match(out.stdout, /⏸ 人の作業待ち: task-planning — 依頼がまだ書かれていない/);
    assert.match(out.stdout, /↩ task-planning の依頼がまだ書かれていないので drive に戻ります。/);
    assert.match(out.stdout, /作業が済んだら y で auto を再開します。/);
    assert.match(out.stdout, /drive を中断しました/);
    assert.equal(events(root, "auto.stopped").length, 1, "auto は 1 回だけ（空回りしない）");
    assert.equal(out.status, 0);
  }

  // (2) A26 も同じ（起動前チェックが通らない）
  {
    const { root } = makeRoot();
    patchYaml(root, (doc) => {
      doc.steps.probe = {
        role: "codex",
        executor: "codex",
        auto: true,
        preflight: [{ command: [process.execPath, "-e", "process.exit(1)"], onFail: "pause", message: "IIS Express を止めてから再開する" }],
        inputs: [],
        outputs: [],
        transitions: { done: { next: "complete" } }
      };
    });
    setStep(root, "probe");
    const out = driveCli(root, "a\nn\n");
    assert.match(out.stdout, /⏸ 人の作業待ち: probe — IIS Express を止めてから再開する/);
    assert.match(out.stdout, /作業が済んだら y で auto を再開します。/);
    assert.equal(events(root, "auto.stopped").length, 1, "auto は 1 回だけ（空回りしない）");
  }

  // (3) 区間外で手で y → exec が断る → run へ進めるかは聞かない（実測: ここで run へ進んで halt していた）
  {
    const { root } = makeRoot();
    patchYaml(root, (doc) => {
      doc.steps["task-planning"].executor = "claude";
    });
    const before = stateText(root);
    const out = driveCli(root, "y\n");
    assert.match(out.stdout, /⏸ "task-planning" を起動しませんでした: 人が書く入力がまだ書かれていません/);
    assert.doesNotMatch(out.stdout, /成果物を確認したら y で検証して次へ/);
    assert.equal(events(root, "workflow.halted").length, 0, "halt しない");
    assert.equal(stateText(root), before);
  }
});
