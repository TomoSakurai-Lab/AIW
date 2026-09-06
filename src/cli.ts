#!/usr/bin/env node
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import {
  approve as engineApprove,
  execStep as engineExecStep,
  initRoot,
  loadConfig,
  nextSuggestion as engineNext,
  reject as engineReject,
  resume as engineResume,
  runStep as engineRunStep,
  statusView,
  EngineError,
  resetForNewTask
} from "./engine/engine.js";
import { clipboardExecutor, clipboardMeta, copyStepPromptToClipboard, visibleOnScreen } from "./engine/executors/index.js";
import type { ExecutorProgress, ExecutorResult } from "./engine/executors/types.js";
import { findRunFile, formatRunLog, readRunLog } from "./engine/codexLog.js";
import { resolveRoot, rootPaths, RUNTIME_DIR_NAME } from "./engine/paths.js";
import { appendEvent } from "./engine/eventLog.js";
import { readBaseline, recaptureBaseline, resolveCheckRepoRoot } from "./engine/gitScope.js";
import { buildObserved } from "./engine/observed.js";
import { buildSummary, formatSummary } from "./engine/summary.js";
import { buildBriefing, formatBriefing } from "./engine/briefing.js";
import { readState as readEngineState } from "./engine/state.js";
import type { PipelineOutcome, ValidationNotice } from "./engine/completion.js";

const program = new Command();

program
  .name("aiw")
  .description("AI workflow engine CLI (config-driven, stateful; design rev.5)")
  .version("0.3.0")
  .option("--root <dir>", `workflow root (default: resolve ${RUNTIME_DIR_NAME} or AIW_ROOT)`);

function engineRoot(): string {
  return resolveRoot(program.opts().root as string | undefined);
}

// Things the pipeline let through on purpose: `report` violations and validators that never ran.
// They are not failures, so they must not change the exit code — but printing nothing at all is
// how a scope violation or an unarmed safety net reaches review unnoticed.
function printNotice(notice: ValidationNotice | undefined): void {
  if (!notice) {
    return;
  }
  for (const r of notice.reported) {
    console.error(`⚠ report: ${r.type} — ${r.message}`);
  }
  for (const s of notice.skipped) {
    console.error(`⚠ skipped: ${s.type} — ${s.skipReason ?? "did not run"} (NOT a pass)`);
  }
}

function printOutcome(outcome: PipelineOutcome): void {
  switch (outcome.kind) {
    case "transitioned":
      console.log(`transitioned: ${outcome.from} -> ${outcome.to} (result: ${outcome.result}${outcome.isRetry ? ", retry" : ""})`);
      printNotice(outcome.notice);
      break;
    case "awaiting-approval":
      console.log(`awaiting approval: step "${outcome.step}". Use "aiw approve" or "aiw reject <reason>".`);
      printNotice(outcome.notice);
      break;
    case "halted": {
      console.error(`HALTED (${outcome.reason}) at step "${outcome.step}": ${outcome.message}`);
      // invalid-status carries the declared transition keys. Printing them turns "result X is not
      // a transition" into an actionable message — without it, operators retry with another guess
      // (measured: `approved` ×2 → `approve` ×2 in two minutes).
      const allowed = outcome.detail?.allowed;
      if (Array.isArray(allowed) && allowed.length > 0) {
        console.error(`allowed result values for "${outcome.step}": ${allowed.join(" | ")}`);
      }
      process.exitCode = 2;
      break;
    }
    case "rerun":
      console.log(`rejected: re-run step "${outcome.step}" (see rejection-note.md).`);
      break;
    case "nothing":
      console.log(outcome.message);
      break;
  }
}

// Print a step's assembled prompt to stdout + clipboard. Default: current step.
//
// M0.4 ではこのコマンドを「workflow.yaml を読まない」設計にしていた（プロンプトファイルの
// 有無が唯一の判定）。M2 で撤回する: Skill / Instructions の宣言は config にしか無く、
// 読まなければ**手順が欠けたプロンプトを黙って出す**ことになるため。config が壊れていれば
// ここで失敗するが、不完全なプロンプトを配るより失敗するほうがよい。
async function enginePromptCmd(stepArg?: string): Promise<void> {
  const root = engineRoot();
  const config = loadConfig(root);
  const step = stepArg ?? readEngineState(root).currentStep;
  const meta = await copyStepPromptToClipboard(root, step, { mode: "print" }, config.steps[step]);
  if (meta.promptFile === null) {
    const promptsDir = rootPaths(root).promptsDir;
    const available = existsSync(promptsDir)
      ? readdirSync(promptsDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => f.replace(/\.md$/, ""))
          .join(", ")
      : "(none)";
    console.error(`no prompt file for step "${step}" (${path.join(promptsDir, `${step}.md`)} not found).`);
    console.error(`available step prompts: ${available}`);
    console.error(`codex steps (implementation / fix) take codex-prompt.md / current-review.md directly.`);
  }
}

// `aiw status [--summary] [--json]`. Plain `status` keeps its original contract (statusView JSON);
// `--summary` adds the M1 confirmation summary, as text by default or structured with `--json`.
function printStatus(withSummary: boolean, asJson: boolean): void {
  const root = engineRoot();
  const view = statusView(root, loadConfig(root));
  if (!withSummary) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  // Two independent sources, kept apart on purpose: `summary` is what the AI claimed in its
  // artifacts, `observed` is what the engine verified. A disagreement between them is the signal.
  const summary = buildSummary(root);
  const observed = buildObserved(root);
  if (asJson) {
    console.log(JSON.stringify({ state: view, claimed: summary, observed }, null, 2));
    return;
  }
  console.log(`step: ${view.currentStep}  status: ${view.status}${view.pendingApproval ? `  (awaiting approval: ${view.pendingApproval})` : ""}`);
  if (view.haltedReason) {
    console.log(`halted: ${view.haltedReason}`);
  }
  console.log("");
  console.log(formatSummary(summary, observed));
  // 承認待ちのときだけ、そのゲート固有の判断材料を足す（2026-09-06）。
  // ⚠️ **表示だけ。** 集計も判定も変えない。承認は人間が判断する行為であり、
  // その材料が画面に無いことが問題だった（executor 化で対話AIの要約が消えたため）。
  if (view.pendingApproval) {
    console.log("");
    console.log(formatBriefing(buildBriefing(root, loadConfig(root), view.pendingApproval)));
  }
}

// `aiw exec <step>`: resolve the step's executor and run it. Produces artifacts only — no
// validation, no transition, no state.json write. `aiw run <step>` still does all of that.
/**
 * 進行の1行サマリを stderr へ流す。
 *
 * **何を画面へ出すかは `visibleOnScreen` が決める**（既定は codex の発言と error のみ）。
 * ここはその判定に従って整形するだけ。
 *
 * clipboard 運用では人間が対話画面で進行を見ていた。executor 化でその可視性を失うと
 * 「30 分走っているが何をしているか分からない」状態になる。
 *
 * ⚠️ **バッファしない。** 届いた順にそのまま出す（進行の異常検知が目的）。
 * ⚠️ 全文は出さない。詳細は runs/ の JSONL にある。
 * 出力先を stderr にするのは、stdout を成果物・機械可読出力のために空けておくため。
 */
function progressPrinter(opts: { quiet?: boolean; verbose?: boolean }): ((e: ExecutorProgress) => void) | undefined {
  if (opts.quiet) {
    return undefined;
  }
  return (e) => {
    if (!visibleOnScreen(e.kind, opts.verbose === true)) {
      return;
    }
    const at = new Date().toTimeString().slice(0, 8);
    console.error(`[${at}] ${e.text}`);
  };
}

/**
 * `aiw log [step]` — 直近の codex 実行を読む（M3・課題I）。
 *
 * **読むだけ。** 情報源は `runs/codex/` の JSONL のみで、新しい記録は作らない。
 * 画面の進行表示は発言だけに絞ってあるので、詳細を後から追う口がここになる。
 */
function engineLogCmd(stepArg: string | undefined, opts: { raw?: boolean; json?: boolean }): void {
  const root = engineRoot();
  const step = stepArg ?? readEngineState(root).currentStep;
  const file = findRunFile(root, step);
  if (!file) {
    console.error(`no codex run recorded for step "${step}" (looked in ${path.join(rootPaths(root).runsDir, "codex")}).`);
    console.error(`runs are written by the codex executor — steps driven through clipboard leave none.`);
    // ⚠️ claude executor（M4）の JSONL は `runs/claude/` へ tee されるが、この整形は
    // codex のイベント語彙（item.* / thread.started）専用で読めない。
    // **「記録が無い」と言って終わらせない**のが要点で、存在するなら場所を教える。
    // claude 側の整形は BL-116（M4 後）。
    const claudeDir = path.join(rootPaths(root).runsDir, "claude");
    const claudeRuns = existsSync(claudeDir)
      ? readdirSync(claudeDir).filter((f) => f.endsWith(`-${step}.jsonl`)).sort()
      : [];
    if (claudeRuns.length > 0) {
      console.error(`→ claude の実行はあります: ${path.join(claudeDir, claudeRuns[claudeRuns.length - 1])}`);
      console.error(`  （この整形は codex のイベント語彙専用なので、今は JSONL を直接読んでください）`);
    }
    process.exitCode = 1;
    return;
  }
  if (opts.raw) {
    process.stdout.write(readFileSync(file, "utf8")); // 一次資料をそのまま
    return;
  }
  const log = readRunLog(root, file);
  console.log(opts.json ? JSON.stringify(log, null, 2) : formatRunLog(log));
}

async function engineExecCmd(stepArg?: string, opts: { quiet?: boolean; verbose?: boolean } = {}): Promise<void> {
  const root = engineRoot();
  const config = loadConfig(root);
  const step = stepArg ?? readEngineState(root).currentStep;
  const result = await engineExecStep(root, config, step, { onProgress: progressPrinter(opts) });
  printExecResult(step, config.steps[step]?.executor ?? "clipboard", result);
}

function printExecResult(step: string, executor: string, result: ExecutorResult): void {
  if (!result.ok) {
    console.error(`exec failed: step "${step}" (executor: ${executor}) — ${result.error ?? "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  const clip = clipboardMeta(result);
  if (clip) {
    console.log(
      clip.outcome === "no-prompt"
        ? `exec: step "${step}" (clipboard) — 専用プロンプトはありません。成果物 + current-status.json を作成してください。`
        : clip.outcome === "copy-failed"
          ? `exec: step "${step}" (clipboard) — クリップボードへコピーできませんでした (${clip.message}). ${clip.promptFile} を直接開いてください。`
          : `exec: step "${step}" (clipboard) — プロンプトをクリップボードにコピーしました。成果物 + current-status.json を作成してください。`
    );
  } else {
    console.log(`exec: step "${step}" (${executor}) — done.`);
  }
  if (result.outputs.length > 0) {
    console.log(`outputs: ${result.outputs.join(", ")}`);
  }
  console.log(`次: 成果物を確認したら \`aiw run ${step}\`。`);
}


// `aiw baseline capture`: 現在の作業ツリー状態を「タスク外」として再固定する。
//
// **検査を骨抜きにできる操作。** 対話確認を必ず挟み、確認を省くオプション（--yes / --force）は
// 追加しない。誤操作防止ではなく、M5 の `aiw auto` から呼ばれないようにするため——
// 無人運転中に自動で baseline を取り直せる経路があると、diff-scope が自動的に無効化される。
// 対話確認があれば無人経路からは構造的に呼べない。
async function baselineCaptureCmd(): Promise<void> {
  const root = engineRoot();
  const config = loadConfig(root);
  const state = readEngineState(root);
  const capturedFor = { step: state.currentStep, fixAttempts: state.fixAttempts };

  const resolved = resolveCheckRepoRoot(root, config);
  if (!resolved.ok) {
    console.error(`baseline capture: checkRepoRoot を解決できません — ${resolved.reason}`);
    process.exitCode = 1;
    return;
  }
  const existing = readBaseline(root);

  console.log(`検査対象リポジトリ: ${resolved.repoRoot}`);
  console.log(`対象ステップ      : ${capturedFor.step}#${capturedFor.fixAttempts}`);
  if (existing) {
    console.log(`既存の baseline   : ${existing.capturedFor.step}#${existing.capturedFor.fixAttempts} (${existing.capturedAt}, dirty ${existing.dirty.length}件)`);
  }
  console.log("");
  console.log("現在の未コミット変更をすべて「タスク外」として再固定します。");
  console.log("**この時点で存在する Codex の逸脱は、以後 diff-scope に検出されなくなります。**");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("続行しますか？ [y/N] ", (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
  if (!/^y(es)?$/i.test(answer)) {
    console.log("中止しました。baseline は変更していません。");
    return;
  }

  const outcome = recaptureBaseline(root, config, capturedFor);
  if (outcome.kind === "failed") {
    console.error(`baseline capture 失敗: ${outcome.reason}`);
    appendEvent(root, "baseline.capture-failed", { step: capturedFor.step, fixAttempts: capturedFor.fixAttempts, actor: "human", message: outcome.reason });
    process.exitCode = 1;
    return;
  }
  appendEvent(root, "baseline.captured", {
    step: capturedFor.step,
    fixAttempts: capturedFor.fixAttempts,
    actor: "human",
    manual: true,
    headSha: outcome.baseline.headSha ? outcome.baseline.headSha.slice(0, 8) : null,
    dirtyCount: outcome.baseline.dirty.length,
    checkRepoRoot: outcome.baseline.checkRepoRoot
  });
  console.log(`baseline を取り直しました（dirty ${outcome.baseline.dirty.length}件）。\`aiw resume\` で再検証してください。`);
}

// `aiw new-task`: reset to a fresh Task Planning start for the next single task. Clears the human
// input (user-task.md) and the working docs (current-*) back to templates, and rewinds state.
// cleanReviewStreak is preserved (audit cadence spans tasks).
function engineNewTaskCmd(): void {
  const root = engineRoot();
  const { restored, discarded } = resetForNewTask(root, loadConfig(root));
  console.log(`new task ready: state reset to "task-planning".`);
  console.log(`  戻した: ${restored.join(", ") || "(なし)"}`);
  // ⚠️ **削除したものを黙らせない。** 特に current-status.json は「テンプレートへ戻す」ではなく
  // 「消す」扱いなので、消えたことが見えないと次の halt の理由が読めなくなる。
  console.log(`  消した: ${discarded.join(", ") || "(なし)"}`);
  console.log("→ write the request into user-task.md, then run `aiw drive` (or produce task-planning outputs and `aiw run task-planning`).");
}

// ---- engine commands (design rev.5) ----
program
  .command("init [dir]")
  .description("Scaffold a new workflow root (mirrors design §12)")
  .option("--force", "overwrite existing config")
  .action((dir: string | undefined, opts: { force?: boolean }) => {
    // ⚠️ 既定名をここへ書かない。resolveRoot のフォールバック（= RUNTIME_DIR_NAME）へ委ねる。
    // 直書きすると migration guard を迂回し、改名前の環境で空のランタイムを作ってしまう。
    const root = resolveRoot(dir ?? (program.opts().root as string | undefined));
    initRoot(root, Boolean(opts.force));
    console.log(`initialized workflow root: ${root}`);
  });

program
  .command("status")
  .description("Show engine state (config-driven root). --summary adds the review summary (Open Decisions / Manual Verification / High Risk / AC)")
  .option("--summary", "include the confirmation summary aggregated from the artifacts")
  .option("--json", "machine-readable output (default for plain `status`)")
  .action((opts: { summary?: boolean; json?: boolean }) => {
    printStatus(Boolean(opts.summary), Boolean(opts.json));
  });

program
  .command("next")
  .description("Suggest the next engine action")
  .action(() => {
    const root = engineRoot();
    const s = engineNext(root, loadConfig(root));
    console.log(`next: ${s.action}`);
    console.log(`reason: ${s.reason}`);
  });

program
  .command("exec [step]")
  .description("Run the step's executor to produce its outputs (default: current step; does NOT touch state.json)")
  .option("--quiet", "進行の1行サマリを出さない（M5 の auto ループ向け）")
  .option("--verbose", "shell / edit / thinking も画面へ出す（既定は codex の発言と error のみ）")
  .action(async (step: string | undefined, opts: { quiet?: boolean; verbose?: boolean }) => {
    await engineExecCmd(step, opts);
  });

program
  .command("log [step]")
  .description("Show the latest codex run for a step (default: current step). Reads runs/codex/ only")
  .option("--raw", "生 JSONL をそのまま出す（一次資料）")
  .option("--json", "機械可読な構造化出力")
  .action((step: string | undefined, opts: { raw?: boolean; json?: boolean }) => {
    engineLogCmd(step, opts);
  });

program
  .command("run <step>")
  .description("Process completion for the current step (§7.7 pipeline)")
  .action((step: string) => {
    const root = engineRoot();
    printOutcome(engineRunStep(root, loadConfig(root), step));
  });

program
  .command("approve")
  .description("Grant a pending approval and continue")
  .action(() => {
    const root = engineRoot();
    printOutcome(engineApprove(root, loadConfig(root)));
  });

program
  .command("reject <reason...>")
  .description("Reject a pending approval (rerun or halt per policy)")
  .action((reason: string[]) => {
    const root = engineRoot();
    printOutcome(engineReject(root, loadConfig(root), reason.join(" ")));
  });

program
  .command("resume")
  .description("Resume after halt/interruption (re-validates or finishes postActions)")
  .action(() => {
    const root = engineRoot();
    printOutcome(engineResume(root, loadConfig(root)));
  });

program
  .command("prompt [step]")
  .description("Print a step's phase prompt (default: current step) to stdout and clipboard")
  .action(async (step: string | undefined) => {
    await enginePromptCmd(step);
  });

program
  .command("drive")
  .description("Interactive y/n driver: guides each phase, copies phase prompts to clipboard")
  .action(runDrive);

program
  .command("baseline")
  .argument("<action>", "capture")
  .description("Re-fix the diff-scope baseline to the current working tree (interactive confirmation required)")
  .action(async (action: string) => {
    if (action !== "capture") {
      console.error(`unknown baseline action "${action}". Only "capture" is supported.`);
      process.exitCode = 1;
      return;
    }
    await baselineCaptureCmd();
  });

program
  .command("new-task")
  .description('Reset to a fresh Task Planning start (clears user-task.md + current-* to templates)')
  .action(() => engineNewTaskCmd());

program.command("shell").description("Start an interactive REPL that accepts workflow commands").action(runShell);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});

// REPL dispatch. Engine commands (rev.5) are first-class; legacy prompt helpers stay reachable.
async function runShellCommand(command: string, args: string[]): Promise<void> {
  switch (command) {
    // ---- engine (design rev.5) ----
    case "status": {
      printStatus(args.includes("--summary"), args.includes("--json"));
      return;
    }
    case "next": {
      const root = engineRoot();
      const s = engineNext(root, loadConfig(root));
      console.log(`next: ${s.action}`);
      console.log(`reason: ${s.reason}`);
      return;
    }
    case "exec":
      await engineExecCmd(args[0]);
      return;
    case "run": {
      const step = args[0];
      if (!step) {
        console.error("usage: run <step>");
        return;
      }
      const root = engineRoot();
      printOutcome(engineRunStep(root, loadConfig(root), step));
      return;
    }
    case "approve": {
      const root = engineRoot();
      printOutcome(engineApprove(root, loadConfig(root)));
      return;
    }
    case "reject": {
      if (args.length === 0) {
        console.error("usage: reject <reason...>");
        return;
      }
      const root = engineRoot();
      printOutcome(engineReject(root, loadConfig(root), args.join(" ")));
      return;
    }
    case "resume": {
      const root = engineRoot();
      printOutcome(engineResume(root, loadConfig(root)));
      return;
    }
    case "prompt":
      await enginePromptCmd(args[0]);
      return;
    case "new-task":
      engineNewTaskCmd();
      return;
    case "drive":
      console.log("`drive` は shell 外で `aiw drive` として実行してください（対話ループのため）。");
      return;
    default:
      console.log('Unknown command. Type "help" for available commands.');
  }
}

// `aiw drive`: an interactive y/n loop over the engine. At each producing step it copies the
// phase prompt to the clipboard and waits for you to create the outputs; at gates it asks to
// approve/reject; on halt it offers resume; at completion it offers to start a new task.
async function runDrive(): Promise<void> {
  // Event-driven line queue (same model as the REPL) so input is consumed deterministically,
  // including piped stdin. `rl.question` races with readline's flowing "line" events; a queue
  // does not. On EOF/close, pending and future asks resolve to "" and the loop exits cleanly.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const buffer: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) {
      w(line.trim());
    } else {
      buffer.push(line.trim());
    }
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) {
      waiters.shift()!("");
    }
  });
  const ask = (q: string): Promise<string> => {
    process.stdout.write(q);
    if (buffer.length) {
      return Promise.resolve(buffer.shift()!);
    }
    if (closed) {
      return Promise.resolve("");
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
  const yes = (a: string): boolean => /^y(es)?$/i.test(a);
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  console.log('aiw drive — y/n で進めます（"n" 等で中断）。\n');
  try {
    while (true) {
      if (closed && buffer.length === 0) {
        break;
      }
      const root = engineRoot();
      const config = loadConfig(root);
      const state = readEngineState(root);
      const step = config.steps[state.currentStep];

      // terminal / unknown step
      if (!step) {
        if (state.currentStep === "complete") {
          console.log("✅ ワークフロー完了。");
          if (yes(await ask("新しいタスクを始めますか？ [y/N] "))) {
            engineNewTaskCmd();
            continue;
          }
        } else {
          console.log(`current step "${state.currentStep}" は不明です。\`aiw status\` を確認してください。`);
        }
        break;
      }

      // halted
      if (state.status === "halted") {
        console.log(`⛔ HALTED (${state.haltedReason}) at "${state.currentStep}".`);
        if (!yes(await ask("入力を直したうえで resume しますか？ [y/N] "))) {
          break;
        }
        safe(() => printOutcome(engineResume(root, config)));
        continue;
      }

      // approval gate
      if (state.pendingApproval) {
        // y/n を聞く前に判断材料を出す。**聞くだけのゲートにしない。**
        safe(() => console.log(`
${formatBriefing(buildBriefing(root, config, state.pendingApproval as string))}
`));
        if (yes(await ask(`承認ゲート: "${state.pendingApproval}" を承認しますか？ [y=承認 / n=却下] `))) {
          safe(() => printOutcome(engineApprove(root, config)));
        } else {
          const reason = await ask("却下理由: ");
          safe(() => printOutcome(engineReject(root, config, reason || "rejected via drive")));
        }
        continue;
      }

      // post-action checkpoint
      if (state.pendingTransition) {
        console.log("postAction チェックポイントが残っています。続行します。");
        safe(() => printOutcome(engineResume(root, config)));
        continue;
      }

      // producing step (claude / codex): copy the prompt, wait for the outputs, then run.
      //
      // M3 段階1: drive も `step.executor` を解決する。ただし**黙って走り出さない** —
      // drive は人間が1ステップずつ確認する経路なので、executor を宣言しているステップでは
      // 起動前に確認を挟み、n なら従来どおり clipboard へ逃がす（不変条件5 を運用面でも保つ）。
      const worker = step.role === "codex" ? "Codex" : "Claude";
      if (step.executor !== "clipboard") {
        const useExecutor = yes(
          await ask(`"${state.currentStep}" は executor: ${step.executor} を宣言しています。${step.executor} で実行しますか？ [y / n=クリップボードへ] `)
        );
        if (useExecutor) {
          console.log(`▶ "${state.currentStep}" を ${step.executor} で実行します（進行を1行ずつ表示）。`);
          // `safe` は同期専用なので、非同期の exec はここで受ける。
          // ⚠️ 失敗しても drive は落とさない（人が次の手を選べる状態で止める）。
          try {
            printExecResult(
              state.currentStep,
              step.executor,
              await engineExecStep(root, config, state.currentStep, { onProgress: progressPrinter({}) })
            );
          } catch (error) {
            console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
          }
          // 成果物の当否は validator が決める。ここでは run へ進めるかだけを聞く。
          if (!yes(await ask("成果物を確認したら y で検証して次へ。 [y / それ以外=中断] "))) {
            console.log("drive を中断しました。準備できたら再度 `aiw drive`。");
            break;
          }
          safe(() => printOutcome(engineRunStep(root, config, state.currentStep)));
          continue;
        }
        console.log(`${step.executor} を使わず、クリップボードへコピーします。`);
      }
      const clip = clipboardMeta(await clipboardExecutor.execute({ root, config, step }));
      // outcome は3値（copied / copy-failed / no-prompt）。promptFile の有無で2値に潰すと
      // copy-failed が「コピーしました」に丸められ、quiet モードでは stderr 警告も出ないため
      // 完全に無言の誤報告になる。printExecResult と同じく outcome で分岐する。
      console.log(
        clip?.outcome === "copied"
          ? `📋 "${state.currentStep}" (${worker}) のプロンプトをクリップボードにコピーしました。${worker} に貼り、成果物 + current-status.json を作成してください。`
          : clip?.outcome === "copy-failed"
            ? `⚠ "${state.currentStep}" (${worker}): クリップボードへコピーできませんでした (${clip.message})。${clip.promptFile} を直接開いて ${worker} に貼り、成果物 + current-status.json を作成してください。`
            : `"${state.currentStep}" (${worker}): 成果物 + current-status.json を作成してください（専用プロンプトなし）。`
      );
      if (!yes(await ask("作成できたら y で検証して次へ。 [y / それ以外=中断] "))) {
        console.log("drive を中断しました。準備できたら再度 `aiw drive`。");
        break;
      }
      safe(() => printOutcome(engineRunStep(root, config, state.currentStep)));
    }
  } finally {
    rl.close();
  }
}

async function runShell(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "aiw> "
  });

  console.log('AI Workflow REPL. Type "help" for available commands, "exit" to quit.');
  rl.prompt();

  rl.on("line", async (line) => {
    const command = line.trim();

    if (command === "") {
      rl.prompt();
      return;
    }

    if (command === "exit" || command === "quit") {
      rl.close();
      return;
    }

    if (command === "help") {
      printShellHelp();
      rl.prompt();
      return;
    }

    const [name, ...args] = command.split(/\s+/);

    rl.pause();
    try {
      await runShellCommand(name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`error: ${message}`);
    }
    rl.resume();
    rl.prompt();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}

function printShellHelp(): void {
  console.log(`Engine commands (design rev.5, ${RUNTIME_DIR_NAME}/):`);
  console.log("  status [--summary] [--json]");
  console.log("                    Engine state. --summary adds Open Decisions / Manual Verification / High Risk / AC");
  console.log("  next              Suggest the next engine action");
  console.log("  exec [step]       Run the step's executor to produce outputs (default: current step; state.json unchanged)");
  console.log("  run <step>        Process completion for the current step (§7.7 pipeline)");
  console.log("  approve           Grant a pending approval and continue");
  console.log("  reject <reason>   Reject a pending approval (rerun or halt per policy)");
  console.log("  resume            Resume after halt/interruption");
  console.log("  prompt [step]     Print a step's phase prompt (default: current step) to stdout + clipboard");
  console.log("  new-task          Reset to a fresh Task Planning start (clears user-task.md + current-*)");
  console.log("  (drive)           Interactive y/n driver — run as `aiw drive` outside the shell");
  console.log("");
  console.log("  help              Show this help message");
  console.log("  exit | quit       Exit the REPL");
}
