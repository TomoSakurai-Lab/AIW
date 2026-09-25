#!/usr/bin/env node
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import {
  approve as engineApprove,
  classifySituation,
  execStep as engineExecStep,
  initRoot,
  loadConfig as engineLoadConfig,
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
import { formatRunLog, readRunLog } from "./engine/codexLog.js";
import { formatClaudeRunLog, readClaudeRunLog } from "./engine/claudeLog.js";
import { findLatestRun } from "./engine/runLog.js";
import { resolveRoot, rootPaths, RUNTIME_DIR_NAME } from "./engine/paths.js";
import { appendEvent } from "./engine/eventLog.js";
import { readBaseline, recaptureBaseline, resolveCheckRepoRoot } from "./engine/gitScope.js";
import { buildObserved } from "./engine/observed.js";
import { buildSummary, formatSummary } from "./engine/summary.js";
import { suggestAuditOnModelChange } from "./engine/audit.js";
import { buildBriefing, formatBriefing } from "./engine/briefing.js";
import { readState as readEngineState } from "./engine/state.js";
import type { PipelineOutcome, ValidationNotice } from "./engine/completion.js";
import { autoIneligibility, releaseAutoLock, returnsToDrive, runAuto, type AutoExecution, type AutoResult, type AutoRetrySettings } from "./engine/auto.js";

const program = new Command();

program
  .name("aiw")
  .description("AI workflow engine CLI (config-driven, stateful; design rev.5)")
  .version("0.3.0")
  .option("--root <dir>", `workflow root (default: resolve ${RUNTIME_DIR_NAME} or AIW_ROOT)`);

// 設定の deprecation（旧キーの読み替え・削除済みキー）を表示する。**黙って読み替えない**（M4.4・2026-09-17）。
// 1 コマンドで設定を何度読んでも表示は 1 回。
let deprecationsShown = false;
function loadConfig(root: string): ReturnType<typeof engineLoadConfig> {
  const config = engineLoadConfig(root);
  if (!deprecationsShown) {
    deprecationsShown = true;
    for (const message of config.deprecations ?? []) {
      console.error(`⚠ deprecated: ${message}`);
    }
    // BL-219: 効かないステップ設定キーも同じ経路で知らせる（黙って受け入れない）
    for (const message of config.ineffectiveStepKeys ?? []) {
      console.error(`⚠ ineffective: ${message}`);
    }
  }
  return config;
}

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
 * `aiw log [step]` — 直近の codex / claude 実行を読む。
 *
 * **読むだけ。** 情報源は `runs/codex/` / `runs/claude/` の JSONL で、新しい記録は作らない。
 * 画面の進行表示は発言だけに絞ってあるので、詳細を後から追う口がここになる。
 */
function engineLogCmd(stepArg: string | undefined, opts: { raw?: boolean; json?: boolean }): void {
  const root = engineRoot();
  const step = stepArg ?? readEngineState(root).currentStep;
  const latest = findLatestRun(root, step);
  if (!latest) {
    console.error(
      `no run recorded for step "${step}" (looked in ${path.join(rootPaths(root).runsDir, "codex")} and ${path.join(rootPaths(root).runsDir, "claude")}).`
    );
    console.error(`runs are written by codex and claude executors — steps driven through clipboard leave none.`);
    process.exitCode = 1;
    return;
  }
  if (opts.raw) {
    process.stdout.write(readFileSync(latest.file, "utf8")); // 一次資料をそのまま
    return;
  }
  const log =
    latest.provider === "codex" ? readRunLog(root, latest.file) : readClaudeRunLog(root, latest.file);
  const formatted = latest.provider === "codex" ? formatRunLog(log as ReturnType<typeof readRunLog>) : formatClaudeRunLog(log as ReturnType<typeof readClaudeRunLog>);
  console.log(opts.json ? JSON.stringify(log, null, 2) : formatted);
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


/** 所要の表示（`6m27s`） */
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** 待機の表示（`5分` / `30秒`） */
function formatWait(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}分` : `${Math.round(ms / 1000)}秒`;
}

function formatRetrySettings(r: AutoRetrySettings): string {
  const waits = r.transientWaitsMs.map((ms) => formatWait(ms).replace("分", "")).join("・");
  return `再試行 total-timeout ${r.totalTimeout}(即時)・idle-timeout ${r.idleTimeout}(${formatWait(r.idleWaitMs)}後)・transient ${r.transient}(${waits}${r.transientWaitsMs[0] >= 60_000 ? "分" : ""})・起動あたり上限 ${r.maxPerRun}`;
}

/**
 * 停止サマリの実行表（設計 課題F の2・3）。行は `auto.stopped` の `executed` として Event Log にも同じものが残る。
 * ⚠️ トークンは **executor 別**に出し、executor をまたいで合算しない（前提1・eventLog.ts の注意）。
 */
function formatAutoRun(executed: AutoExecution[]): string[] {
  if (executed.length === 0) {
    return ["  （この起動ではステップを実行していない）"];
  }
  const lines = executed.map((e, i) => {
    const model = e.modelObserved && e.modelObserved !== e.modelRequested ? `${e.modelRequested ?? "-"} → ${e.modelObserved}` : (e.modelRequested ?? "-");
    const retry = e.retries > 0 ? `  再試行 ${e.retries}` : "";
    return `  ${i + 1}. ${e.step.padEnd(14)} ${e.executor}·${model}  ${formatDuration(e.durationMs).padStart(7)}  ${e.result}${retry}  session: fresh`;
  });
  for (const e of executed) {
    for (const r of e.reported) {
      lines.push(`     ⚠ report (${e.step}): ${r}`);
    }
  }
  const byExecutor = new Map<string, { input: number; output: number; cacheRead: number; measured: boolean }>();
  for (const e of executed) {
    const t = byExecutor.get(e.executor) ?? { input: 0, output: 0, cacheRead: 0, measured: false };
    if (e.tokens) {
      t.measured = true;
      t.input += e.tokens.inputTokens ?? 0;
      t.output += e.tokens.outputTokens ?? 0;
      t.cacheRead += e.tokens.cacheReadTokens ?? 0;
    }
    byExecutor.set(e.executor, t);
  }
  for (const [executor, t] of byExecutor) {
    lines.push(
      t.measured
        ? `  tokens (${executor}): in ${t.input} / out ${t.output} / cacheRead ${t.cacheRead}（inputTokens の意味は executor ごとに違う。合算しない）`
        : `  tokens (${executor}): -（計測なし）`
    );
  }
  return lines;
}

/**
 * `aiw auto`（M5・docs/design-auto.md）。承認ゲートの後の無人区間を、人間の代わりに exec → run と叩き続ける。
 *
 * 本体（停止条件・予算・再試行・ロック）は engine/auto.ts。ここは表示と Ctrl+C と終了コードだけ。
 * **drive とは別コマンド**: drive は対話（stdin を読む）、auto は無対話で終了コードを返す
 * （同じコマンドのモードにすると、スクリプトから呼んだときに stdin 待ちで止まる経路が残る）。
 */
async function engineAutoCmd(opts: {
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
  maxSteps?: string;
  /** drive の auto モードから呼ぶ。停止サマリの後半（status --summary・判断材料・next）は drive 側が出すので省く */
  fromDrive?: boolean;
}): Promise<AutoResult> {
  const root = engineRoot();
  const config = loadConfig(root);
  // --json のときは stdout を最後の1行の JSON のために空け、人間向けの表示は stderr へ出す
  const out = (text: string): void => (opts.json ? console.error(text) : console.log(text));
  const maxSteps = opts.maxSteps === undefined ? undefined : Number(opts.maxSteps);

  // Ctrl+C: 1回目は auto の AbortController を撃ち、executor の終了を待つ（A20 / A22）。2回目は即時終了（A21）。
  const controller = new AbortController();
  let runId: string | null = null;
  let sigints = 0;
  const onSigint = (): void => {
    sigints++;
    if (sigints === 1) {
      console.error("⏹ 中断要求を受け付けた — 実行中のものの終了を待っています（もう一度 Ctrl+C で強制終了）");
      controller.abort();
      return;
    }
    console.error("⏹ 強制終了: 子プロセスが残っている可能性 — Get-Process codex,claude で確認");
    if (runId) {
      releaseAutoLock(root, runId);
    }
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  const printProgress = progressPrinter({ quiet: opts.quiet, verbose: opts.verbose });
  let result: AutoResult;
  try {
    result = await runAuto(root, config, {
      maxSteps,
      signal: controller.signal,
      reporter: {
        started: (info) => {
          runId = info.runId;
          const breakdown = info.budget.breakdown.map((b) => `${b.step} ${b.count}`).join(" + ");
          const budget =
            info.budget.source === "derived"
              ? `予算 ${info.budget.total} = ${breakdown}`
              : `予算 ${info.budget.total}（${info.budget.source === "cli" ? "--max-steps" : "settings.autoMaxSteps"}。導出値 ${info.budget.derived} = ${breakdown}）`;
          out(`aiw auto — ${budget} / ${formatRetrySettings(info.retry)}`);
          if (info.takenOver) {
            out(`⚠ 古いロックを引き継いだ（pid ${info.takenOver.pid} は存在しない。開始 ${info.takenOver.startedAt}）`);
          }
        },
        stepStarted: ({ index, budget, step, model, effort }) => {
          const detail = [step.executor, model ?? "model 未指定", ...(effort ? [`effort ${effort}`] : [])].join(" · ");
          out(`▶ [${index}/${budget}] ${step.id}  (${detail})`);
        },
        progress: printProgress,
        retrying: ({ step, cause, attempt, max, waitMs }) => {
          const when = waitMs > 0 ? `${formatWait(waitMs)}後に再試行` : "即時に再試行";
          out(`↻ ${step}: ${cause} — ${when} (${attempt}/${max})   Ctrl+C で中断`);
        },
        outcome: (outcome, { step, durationMs }) => {
          const took = formatDuration(durationMs);
          if (outcome.kind === "transitioned") {
            out(`✓ ${outcome.from} → ${outcome.to}  (${took})`);
          } else if (outcome.kind === "awaiting-approval") {
            out(`✓ ${step} → 承認待ち  (${took})`);
          } else if (outcome.kind === "halted") {
            printOutcome(outcome);
          } else {
            out(`${step}: ${outcome.kind}  (${took})`);
          }
          if (outcome.kind === "transitioned" || outcome.kind === "awaiting-approval") {
            // report 違反は停止に格上げしない（前提5）。**黙らせもしない**
            printNotice(outcome.notice);
          }
          // run コマンドと同じ提案（表示だけ。判定には影響しない）
          const suggestion = suggestAuditOnModelChange(root, config, step);
          if (suggestion) {
            out(`⚠ ${suggestion.message}`);
          }
        },
        resumed: (outcome) => {
          const detail =
            outcome.kind === "transitioned" ? `${outcome.from} → ${outcome.to}` : outcome.kind === "halted" ? `HALT(${outcome.reason})` : outcome.kind;
          out(`postAction チェックポイントを resume した: ${detail}`);
        }
      }
    });
  } finally {
    process.off("SIGINT", onSigint);
  }

  out("");
  out(result.line);
  if (!opts.quiet && result.stop !== "refused") {
    out("");
    out(`この起動の実行 (${result.executed.length}/${result.budget?.total ?? "-"}):`);
    for (const line of formatAutoRun(result.executed)) {
      out(line);
    }
    if (!opts.fromDrive) {
      out("");
      out(formatSummary(buildSummary(root), buildObserved(root)));
      if (result.stop === "gate" && result.step) {
        out("");
        out(formatBriefing(buildBriefing(root, config, result.step)));
      }
      const next = engineNext(root, config);
      out("");
      out(`next: ${next.action}`);
    }
  }
  if (opts.json) {
    console.log(
      JSON.stringify({
        stop: result.stop,
        condition: result.condition,
        step: result.step,
        reason: result.line,
        exitCode: result.exitCode,
        runId: result.runId,
        executed: result.executed
      })
    );
  }
  process.exitCode = result.exitCode;
  return result;
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
  .description("Show the latest codex or claude run for a step (default: current step)")
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
    const config = loadConfig(root);
    printOutcome(engineRunStep(root, config, step));
    // ⚠️ **判定の後。** 提案は表示だけで、run の判定・遷移・exit code には影響しない
    // （auditPolicy の counterOwner: cli という既存の分担どおり）。
    const suggestion = suggestAuditOnModelChange(root, config, step);
    if (suggestion) {
      console.log(`
⚠ ${suggestion.message}`);
      console.log(`  → aiw exec review-audit / aiw run review-audit（standalone。通常フローは止めない）`);
    }
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
  .command("auto")
  .description(
    "Unattended exec → run over the auto: true steps; stops at gates / clipboard / halt (exit 0 human turn, 1 refused, 2 halt, 3 budget, 4 exec failed, 5 no progress, 130 Ctrl+C)"
  )
  .option("--quiet", "進行の1行を抑え、ステップの見出しと停止の1行だけを出す")
  .option("--verbose", "shell / edit / thinking も画面へ出す（既定は発言と error のみ）")
  .option("--json", "最後に1行の JSON を stdout へ出す（人間向けの表示は stderr）")
  .option("--max-steps <n>", "この起動でのステップ実行回数の上限（既定は workflow.yaml から導出。settings.autoMaxSteps より優先）")
  .action(async (opts: { quiet?: boolean; verbose?: boolean; json?: boolean; maxSteps?: string }) => {
    await engineAutoCmd(opts);
  });

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
    case "auto":
      console.log("`auto` は shell 外で `aiw auto` として実行してください（終了コードと Ctrl+C を扱うため）。");
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

  // auto モード（`a` で入る。2026-09-25 の決定・docs/design-auto.md 課題E）。
  // 一度入ったら、以後の無人区間のステップは確認なしで auto に任せ、**人の番（終了コード 0）で drive へ戻る**。
  // 承認ゲートでは drive がふだんどおり判断材料を出して聞く——承認するのは人で、auto は承認を呼ばない。
  // 異常停止（halt・予算・executor 失敗・無進行・中断・起動拒否）なら drive も終わる。
  let autoMode = false;
  // readline は開いたまま auto を走らせる（戻った後にまた聞くため）。端末では readline が Ctrl+C を吸うので、
  // auto の中断（A20 / A21）へ中継する。
  const forwardSigint = (): void => {
    process.emit("SIGINT", "SIGINT");
  };
  /** 1区間ぶん auto を走らせる。戻り値は drive を続けるか */
  const runAutoLeg = async (): Promise<boolean> => {
    rl.on("SIGINT", forwardSigint);
    let result: AutoResult;
    try {
      // ロックはここ（runAuto の中）で取る。drive はそれまでロックを見ない（既存の挙動のまま）。
      result = await engineAutoCmd({ fromDrive: true });
    } finally {
      rl.off("SIGINT", forwardSigint);
    }
    // ⚠️ 端末では、auto の実行中に打たれた入力を捨てる。数十分の無人区間の間に押したキーが、
    // 戻った直後の承認ゲートの答えとして読まれてしまう（承認を事前入力で通さない）。パイプ入力は意図した答えなので残す。
    if (process.stdin.isTTY) {
      buffer.length = 0;
    }
    if (!returnsToDrive(result)) {
      console.log("drive を終了します（auto の停止理由を確認してから、再度 `aiw drive` か `aiw auto`）。");
      return false;
    }
    console.log("\n↩ 人の番なので drive に戻ります。\n");
    return true;
  };

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
      // 判定は next / auto と同じ classifySituation（優先順位の正本は docs/design-auto.md 課題E）。
      // ⚠️ 以前の drive は「ステップ未定義」を最初に見ていたので、halt や承認待ちと同時に立つと
      // 「不明」と言って終わっていた（Test 190）。終端も文字列 "complete" と比べていた（Test 191）。
      // ここでは各状況の扱い（何を聞くか）だけを書き、**どの状況かは判定しない**。
      // ⚠️ `switch` にしない: 分岐の中の `break` がループではなく switch を抜けてしまう。
      //    書き直すと、halt や終端で n と答えても drive が終わらず、同じ質問を繰り返すようになる。
      const situation = classifySituation(state, config);

      // halted
      if (situation.kind === "halted") {
        console.log(`⛔ HALTED (${situation.reason}) at "${situation.step}".`);
        if (!yes(await ask("入力を直したうえで resume しますか？ [y/N] "))) {
          break;
        }
        safe(() => printOutcome(engineResume(root, config)));
        continue;
      }

      // approval gate
      if (situation.kind === "awaiting-approval") {
        const gate = situation.step;
        // y/n を聞く前に判断材料を出す。**聞くだけのゲートにしない。**
        safe(() => console.log(`
${formatBriefing(buildBriefing(root, config, gate))}
`));
        if (yes(await ask(`承認ゲート: "${gate}" を承認しますか？ [y=承認 / n=却下] `))) {
          safe(() => printOutcome(engineApprove(root, config)));
        } else {
          const reason = await ask("却下理由: ");
          safe(() => printOutcome(engineReject(root, config, reason || "rejected via drive")));
        }
        continue;
      }

      // post-action checkpoint
      if (situation.kind === "checkpoint") {
        console.log("postAction チェックポイントが残っています。続行します。");
        safe(() => printOutcome(engineResume(root, config)));
        continue;
      }

      // terminal（config から導出。`complete` 以外の名前の終端でも終わる）
      if (situation.kind === "terminal") {
        console.log("✅ ワークフロー完了。");
        if (yes(await ask("新しいタスクを始めますか？ [y/N] "))) {
          engineNewTaskCmd();
          continue;
        }
        break;
      }

      // unknown step
      if (situation.kind === "unknown") {
        console.log(`current step "${situation.state}" は不明です。\`aiw status\` を確認してください。`);
        break;
      }

      const step = situation.step;

      // producing step (claude / codex): copy the prompt, wait for the outputs, then run.
      //
      // M3 段階1: drive も `step.executor` を解決する。ただし**黙って走り出さない** —
      // drive は人間が1ステップずつ確認する経路なので、executor を宣言しているステップでは
      // 起動前に確認を挟み、n なら従来どおり clipboard へ逃がす（不変条件5 を運用面でも保つ）。
      const worker = step.role === "codex" ? "Codex" : "Claude";
      if (step.executor !== "clipboard") {
        // auto モード中の無人区間のステップは聞かずに auto へ。区間の規則は auto と同じ関数で見る。
        if (autoMode && autoIneligibility(step) === null) {
          console.log(`▶ auto モード: "${state.currentStep}" から無人区間を進めます。`);
          if (await runAutoLeg()) {
            continue;
          }
          break;
        }
        const answer = await ask(
          `"${state.currentStep}" は executor: ${step.executor} で実行します。\n[y=実行 / n=クリップボードへ / a=ここから auto（人の番で drive に戻る）] `
        );
        // a: auto モードに入る。auto の停止条件・終了コード・ロック・再試行をそのまま使い、drive 用には何も複製しない。
        if (/^a(uto)?$/i.test(answer)) {
          // drive から入っても auto: true でないステップは無人にしない（既定 false・黙って無人区間に入らない）。
          if (autoIneligibility(step) !== null) {
            console.log(`"${state.currentStep}" は無人対象外です（auto: true の宣言が無い）。y/n で進めてください。`);
            continue;
          }
          autoMode = true;
          console.log(
            "▶ auto モードに入ります: 無人区間は確認なしで進め、承認ゲート・clipboard のステップなど人の番で drive に戻ります（異常で止まったら drive も終わります）。"
          );
          if (await runAutoLeg()) {
            continue;
          }
          break;
        }
        const useExecutor = yes(answer);
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
  console.log("  (auto)            Unattended exec → run over auto: true steps — run as `aiw auto` outside the shell");
  console.log("");
  console.log("  help              Show this help message");
  console.log("  exit | quit       Exit the REPL");
}
