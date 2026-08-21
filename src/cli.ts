#!/usr/bin/env node
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import {
  getWorkflowContext,
  readWorkflowFileIfExists,
  REQUIRED_STATUS_FILES,
  warnMissingWorkflowFile,
  workflowFileExists
} from "./files.js";
import { runHeartbeat } from "./heartbeat.js";
import { phaseForStep, readModelPolicy } from "./policy.js";
import {
  CODEX_PROMPT,
  FIX_PROMPT,
  IMPROVE_CHECK_PROMPT,
  REFLECT_PROMPT,
  RESEARCH_DEFAULT_PROMPT,
  REVIEW_PROMPT,
  loadTemplateOrDefault,
  outputPrompt
} from "./prompt.js";
import { readState, updateState } from "./state.js";
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
  EngineError
} from "./engine/engine.js";
import { clipboardExecutor, clipboardMeta, copyStepPromptToClipboard, driveExecutorNotice, visibleOnScreen } from "./engine/executors/index.js";
import type { ExecutorProgress, ExecutorResult } from "./engine/executors/types.js";
import { resolveRoot, rootPaths } from "./engine/paths.js";
import { appendEvent } from "./engine/eventLog.js";
import { deleteBaseline, readBaseline, recaptureBaseline, resolveCheckRepoRoot } from "./engine/gitScope.js";
import { buildObserved } from "./engine/observed.js";
import { buildSummary, formatSummary } from "./engine/summary.js";
import { readState as readEngineState, writeState as writeEngineState } from "./engine/state.js";
import { DEFAULT_ENGINE_STATE } from "./engine/types.js";
import type { PipelineOutcome, ValidationNotice } from "./engine/completion.js";

const program = new Command();

program
  .name("aiw")
  .description("AI workflow engine CLI (config-driven, stateful; design rev.5)")
  .version("0.3.0")
  .option("--root <dir>", "workflow root (default: resolve .ai-workflow2 or AIW_ROOT)");

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
  const { templatesDir } = rootPaths(root);
  const abs = path.resolve(root);
  for (const f of ["user-task.md", "current-task.md", "current-result.md", "current-review.md"]) {
    const tmpl = path.join(templatesDir, f);
    if (existsSync(tmpl)) {
      copyFileSync(tmpl, path.join(abs, f));
    }
  }
  // 前タスクの baseline と違反レポートが次タスクの検査を汚さないように消す。
  deleteBaseline(root);
  rmSync(path.join(path.resolve(root), "scope-violation-report.md"), { force: true });
  const prev = readEngineState(root);
  writeEngineState(root, { ...DEFAULT_ENGINE_STATE, cleanReviewStreak: prev.cleanReviewStreak });
  console.log('new task ready: state reset to "task-planning"; user-task.md and current-* cleared.');
  console.log("→ write the request into user-task.md, then run `aiw drive` (or produce task-planning outputs and `aiw run task-planning`).");
}

// ---- engine commands (design rev.5) ----
program
  .command("init [dir]")
  .description("Scaffold a new workflow root (mirrors design §12)")
  .option("--force", "overwrite existing config")
  .action((dir: string | undefined, opts: { force?: boolean }) => {
    const root = resolveRoot(dir ?? (program.opts().root as string | undefined) ?? ".ai-workflow2");
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

program.command("legacy-status").description("[legacy] Show .ai-workflow state and required file status").action(runStatus);
program.command("legacy-next").description("[legacy] Run the next .ai-workflow prompt command").action(runNext);
program.command("heartbeat").description("Generate a heartbeat prompt").action(runHeartbeatCommand);
program.command("research").description("Generate a research prompt").action(runResearch);
program.command("codex").description("Generate a Codex implementation prompt").action(runCodex);
program.command("review").description("Generate a review prompt").action(runReview);
program.command("fix").description("Generate a Fix Scope prompt").action(runFix);
program
  .command("improve-check")
  .description("Generate an improve-check prompt after fixes")
  .action(runImproveCheck);
program.command("reflect").description("Generate a reflection prompt").action(runReflect);
program.command("policy").description("Show recommended model and effort for each phase").action(runPolicy);
program.command("shell").description("Start an interactive REPL that accepts workflow commands").action(runShell);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});

async function runStatus(): Promise<void> {
  const ctx = getWorkflowContext();
  const state = await readState(ctx);

  console.log("AI Workflow Status");
  console.log(`root: ${ctx.rootDir}`);
  console.log("");
  console.log("state:");
  for (const [key, value] of Object.entries(state)) {
    console.log(`  ${key}: ${value === null ? "null" : String(value)}`);
  }

  console.log("");
  console.log("files:");
  for (const file of REQUIRED_STATUS_FILES) {
    const mark = workflowFileExists(ctx, file) ? "ok" : "missing";
    console.log(`  ${mark.padEnd(7)} .ai-workflow/${file}`);
  }

  const policy = await readModelPolicy(ctx);
  const phase = phaseForStep(String(state.currentStep));
  const entry = phase ? policy[phase] : undefined;

  console.log("");
  console.log(`Current Step: ${state.currentStep}`);
  console.log("");
  if (entry) {
    console.log("Recommended:");
    console.log(`- Model: ${entry.model}`);
    console.log(`- Effort: ${entry.effort}`);
    console.log(`- Reason: ${entry.reason}`);
  } else {
    console.log("Recommended: (no model policy defined for this step)");
  }
}

async function runNext(): Promise<void> {
  const decision = await resolveNextCommand();

  if (decision.command) {
    console.error(`next: aiw ${decision.command}`);
    console.error(`reason: ${decision.reason}`);
    await runWorkflowCommand(decision.command);
    return;
  }

  console.log("Next command suggestion");
  if (decision.currentStep) {
    console.log(`currentStep: ${decision.currentStep}`);
  }
  if (decision.ready) {
    console.log(`reviewReady: ${decision.ready}`);
  }
  console.log("");
  printNext(decision.label, decision.reason);
}

async function resolveNextCommand(): Promise<NextDecision> {
  const ctx = getWorkflowContext();
  const state = await readState(ctx);
  const hasResult = workflowFileExists(ctx, "current-result.md");
  const hasReview = workflowFileExists(ctx, "current-review.md");
  const reviewText = hasReview ? await readWorkflowFileIfExists(ctx, "current-review.md") : null;
  const ready = parseReady(reviewText);

  switch (state.currentStep) {
    case "idle":
      return nextCommand("research", "Prepare research output, context-package.md, and codex-prompt.md.", state.currentStep, ready);
    case "research":
      return nextCommand("codex", "Send the implementation prompt to a task-scoped Codex session.", state.currentStep, ready);
    case "codex-running":
      if (hasResult) {
        return nextCommand("review", "current-result.md exists, so review can start.", state.currentStep, ready);
      }
      return nextCommand("heartbeat", "Codex is still running; send a heartbeat prompt.", state.currentStep, ready);
    case "review":
      if (!hasReview) {
        return nextCommand("review", "current-review.md is not available yet.", state.currentStep, ready);
      }
      if (ready === "READY FOR FIX") {
        return nextCommand("fix", "The review says Critical/Major fixes are required.", state.currentStep, ready);
      }
      if (ready === "READY FOR REFLECTION") {
        return nextCommand("reflect", "The review is ready for reflection.", state.currentStep, ready);
      }
      return nextSuggestion("aiw fix or aiw reflect", "Check current-review.md Ready and Fix Scope sections.", state.currentStep, ready);
    case "fix":
      return nextCommand("improve-check", "After fixes, verify that Critical items are resolved.", state.currentStep, ready);
    case "improve-check":
      if (ready === "READY FOR REFLECTION") {
        return nextCommand("reflect", "Improve Check indicates reflection can start.", state.currentStep, ready);
      }
      return nextCommand("improve-check", "Run Improve Check again, or run aiw fix manually if Critical remains.", state.currentStep, ready);
    case "reflection":
    case "done":
      return nextSuggestion("done", "Workflow is complete.", state.currentStep, ready);
    default:
      return nextSuggestion("aiw status", "currentStep is unknown; inspect state before continuing.", String(state.currentStep), ready);
  }
}

async function runWorkflowCommand(command: NextRunnableCommand): Promise<void> {
  switch (command) {
    case "heartbeat":
      await runHeartbeatCommand();
      break;
    case "research":
      await runResearch();
      break;
    case "codex":
      await runCodex();
      break;
    case "review":
      await runReview();
      break;
    case "fix":
      await runFix();
      break;
    case "improve-check":
      await runImproveCheck();
      break;
    case "reflect":
      await runReflect();
      break;
  }
}

async function runHeartbeatCommand(): Promise<void> {
  const ctx = getWorkflowContext();
  const prompt = await runHeartbeat(ctx);
  await outputPrompt(prompt);
  await printRecommendation(ctx, "implementation");
}

async function runResearch(): Promise<void> {
  const ctx = getWorkflowContext();
  warnMissingWorkflowFile(ctx, "current-task.md");
  const prompt = await loadTemplateOrDefault(ctx, "research.md", RESEARCH_DEFAULT_PROMPT);
  await updateState(ctx, { currentStep: "research" });
  await outputPrompt(prompt);
  await printRecommendation(ctx, "research");
}

async function runCodex(): Promise<void> {
  const ctx = getWorkflowContext();
  warnMissingWorkflowFile(ctx, "codex-system.md");
  warnMissingWorkflowFile(ctx, "context-package.md");
  warnMissingWorkflowFile(ctx, "codex-prompt.md");
  await updateState(ctx, {
    currentStep: "codex-running",
    codexRunning: true
  });
  const prompt = await loadTemplateOrDefault(ctx, "coding.md", CODEX_PROMPT);
  await outputPrompt(prompt);
  await printRecommendation(ctx, "implementation");
}

async function runReview(): Promise<void> {
  const ctx = getWorkflowContext();
  warnMissingWorkflowFile(ctx, "context.md");
  warnMissingWorkflowFile(ctx, "current-task.md");
  warnMissingWorkflowFile(ctx, "context-package.md");
  warnMissingWorkflowFile(ctx, "codex-prompt.md");
  warnMissingWorkflowFile(ctx, "current-result.md");
  await updateState(ctx, {
    currentStep: "review",
    codexRunning: false
  });
  const prompt = await loadTemplateOrDefault(ctx, "review.md", REVIEW_PROMPT);
  await outputPrompt(prompt);
  await printRecommendation(ctx, "review");
}

async function runFix(): Promise<void> {
  const ctx = getWorkflowContext();
  warnMissingWorkflowFile(ctx, "codex-system.md");
  warnMissingWorkflowFile(ctx, "context-package.md");
  warnMissingWorkflowFile(ctx, "current-review.md");
  await updateState(ctx, {
    currentStep: "fix",
    codexRunning: true
  });
  const prompt = await loadTemplateOrDefault(ctx, "improve.md", FIX_PROMPT);
  await outputPrompt(prompt);
  await printRecommendation(ctx, "fix");
}

async function runImproveCheck(): Promise<void> {
  const ctx = getWorkflowContext();
  warnMissingWorkflowFile(ctx, "current-review.md");
  warnMissingWorkflowFile(ctx, "current-result.md");
  await updateState(ctx, {
    currentStep: "improve-check",
    codexRunning: false
  });
  const prompt = await loadTemplateOrDefault(ctx, "improve-check.md", IMPROVE_CHECK_PROMPT);
  await outputPrompt(prompt);
  await printRecommendation(ctx, "improve-check");
}

async function runReflect(): Promise<void> {
  const ctx = getWorkflowContext();
  warnMissingWorkflowFile(ctx, "context.md");
  warnMissingWorkflowFile(ctx, "current-task.md");
  warnMissingWorkflowFile(ctx, "context-package.md");
  warnMissingWorkflowFile(ctx, "current-result.md");
  warnMissingWorkflowFile(ctx, "current-review.md");
  warnMissingWorkflowFile(ctx, "learnings.md");
  await updateState(ctx, {
    currentStep: "reflection",
    codexRunning: false
  });
  const prompt = await loadTemplateOrDefault(ctx, "reflection.md", REFLECT_PROMPT);
  await outputPrompt(prompt);
  await printRecommendation(ctx, "reflection");
}

async function printRecommendation(ctx: ReturnType<typeof getWorkflowContext>, phase: string): Promise<void> {
  const policy = await readModelPolicy(ctx);
  const entry = policy[phase];
  if (!entry) {
    return;
  }

  console.log("");
  console.log("Recommended:");
  console.log(`- Model: ${entry.model}`);
  console.log(`- Effort: ${entry.effort}`);
  console.log(`- Reason: ${entry.reason}`);
}

async function runPolicy(): Promise<void> {
  const ctx = getWorkflowContext();
  const policy = await readModelPolicy(ctx);

  console.log("Model Policy (recommended model and effort per phase)");
  console.log("");
  for (const [phase, entry] of Object.entries(policy)) {
    console.log(`${phase}:`);
    console.log(`- Model: ${entry.model}`);
    console.log(`- Effort: ${entry.effort}`);
    console.log(`- Reason: ${entry.reason}`);
    console.log("");
  }
}

// REPL dispatch. Engine commands (rev.5) are first-class; legacy prompt helpers stay reachable.
async function runShellCommand(command: string, args: string[]): Promise<void> {
  switch (command) {
    // ---- engine (design rev.5, .ai-workflow2/) ----
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
    // ---- legacy prompt helpers (.ai-workflow/) ----
    case "legacy-status":
      await runStatus();
      return;
    case "legacy-next":
      await runNext();
      return;
    case "heartbeat":
      await runHeartbeatCommand();
      return;
    case "research":
      await runResearch();
      return;
    case "codex":
      await runCodex();
      return;
    case "review":
      await runReview();
      return;
    case "fix":
      await runFix();
      return;
    case "improve-check":
      await runImproveCheck();
      return;
    case "reflect":
      await runReflect();
      return;
    case "policy":
      await runPolicy();
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
      // drive is the human-in-the-loop path, so it always uses the clipboard executor directly —
      // it does not resolve step.executor (that is `aiw exec` / M4's `aiw auto`) and does not
      // write Event Log entries.
      const worker = step.role === "codex" ? "Codex" : "Claude";
      // 宣言が効いていないことを黙って通さない（M3・段階2）。
      const ignored = driveExecutorNotice(state.currentStep, step.executor);
      if (ignored) {
        console.error(ignored);
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
  console.log("Engine commands (design rev.5, .ai-workflow2/):");
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
  console.log("Legacy prompt helpers (.ai-workflow/):");
  console.log("  legacy-status     [legacy] Show .ai-workflow state and required file status");
  console.log("  legacy-next       [legacy] Run the next .ai-workflow prompt command");
  console.log("  heartbeat         Generate a heartbeat prompt");
  console.log("  research          Generate a research prompt");
  console.log("  codex             Generate a Codex implementation prompt");
  console.log("  review            Generate a review prompt");
  console.log("  fix               Generate a Fix Scope prompt");
  console.log("  improve-check     Generate an improve-check prompt after fixes");
  console.log("  reflect           Generate a reflection prompt");
  console.log("  policy            Show recommended model and effort for each phase");
  console.log("");
  console.log("  help              Show this help message");
  console.log("  exit | quit       Exit the REPL");
}

function parseReady(reviewText: string | null): "READY FOR FIX" | "READY FOR REFLECTION" | null {
  if (!reviewText) {
    return null;
  }

  if (reviewText.includes("READY FOR FIX")) {
    return "READY FOR FIX";
  }

  if (reviewText.includes("READY FOR REFLECTION")) {
    return "READY FOR REFLECTION";
  }

  return null;
}

type NextRunnableCommand =
  | "heartbeat"
  | "research"
  | "codex"
  | "review"
  | "fix"
  | "improve-check"
  | "reflect";

type NextDecision = {
  command: NextRunnableCommand | null;
  label: string;
  reason: string;
  currentStep?: string;
  ready?: "READY FOR FIX" | "READY FOR REFLECTION" | null;
};

function nextCommand(
  command: NextRunnableCommand,
  reason: string,
  currentStep?: string,
  ready?: "READY FOR FIX" | "READY FOR REFLECTION" | null
): NextDecision {
  return {
    command,
    label: `aiw ${command}`,
    reason,
    currentStep,
    ready
  };
}

function nextSuggestion(
  label: string,
  reason: string,
  currentStep?: string,
  ready?: "READY FOR FIX" | "READY FOR REFLECTION" | null
): NextDecision {
  return {
    command: null,
    label,
    reason,
    currentStep,
    ready
  };
}

function printNext(command: string, reason: string): void {
  console.log(`next: ${command}`);
  console.log(`reason: ${reason}`);
}
