import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendEvent } from "./eventLog.js";
import { captureIfAbsent } from "./gitScope.js";
import { getStep } from "./loader.js";
import { defaultPostActions, parseFeaturePhases, type PostActionContext, type PostActionRegistry } from "./postActions.js";
import { evaluateRetry, isRetryEntry } from "./retry.js";
import { readState, writeState } from "./state.js";
import { readStatus } from "./status.js";
import type { EngineState, HaltedReason, PendingTransition, Status, WorkflowConfig } from "./types.js";
import { runValidators, type ValidationOutcome } from "./validators.js";
import { versionInfo } from "./versions.js";

// Carried on the non-halting outcomes so the CLI can warn about things that did NOT stop the
// pipeline: `report` violations and skipped validators. Without this they exist only in the Event
// Log while the console prints a plain `transitioned:` success line.
export type ValidationNotice = {
  reported: Array<{ type: string; message: string }>;
  skipped: Array<{ type: string; skipReason?: string }>;
};

export type PipelineOutcome =
  | { kind: "transitioned"; from: string; to: string; result: string; isRetry: boolean; notice?: ValidationNotice }
  | { kind: "awaiting-approval"; step: string; notice?: ValidationNotice }
  | { kind: "halted"; step: string; reason: HaltedReason; message: string; detail?: Record<string, unknown> }
  | { kind: "rerun"; step: string }
  | { kind: "nothing"; message: string };

export type CompletionOptions = {
  approvalGranted?: boolean;
  postActions?: PostActionRegistry;
  faultBeforeCommit?: boolean; // test seam: simulate a crash just before the state commit (step 9)
  onValidate?: () => void; // test seam: fires when the validation phase (steps 2–5) is entered
};

// Collects what the pipeline let through: violations whose onViolation is `report`, and validators
// that never ran. Returns undefined when there is nothing to warn about.
function buildNotice(validation: ValidationOutcome): ValidationNotice | undefined {
  const reported = validation.violations
    .filter((v) => v.onViolation === "report")
    .map((v) => ({ type: v.type, message: v.message }));
  const skipped = validation.results
    .filter((r) => r.status === "skipped")
    .map((r) => ({ type: r.type, skipReason: r.skipReason }));
  return reported.length > 0 || skipped.length > 0 ? { reported, skipped } : undefined;
}

// 遷移確定時の baseline capture。
//
// **postActions には入れない。** postActions は pendingTransition のチェックポイント対象で
// resume 時に再実行されうる。baseline を resume のたびに取り直すと Codex が既に行った変更が
// baseline へ吸収され、diff-scope が無言で無効化される（罠1）。captureIfAbsent は冪等なので
// 実害は出ない設計だが、二重に守るより置き場所を正しくする。
//
// トリガーは workflow.yaml に書かせず「遷移先 step が diff-scope を宣言していれば必ず capture」
// というエンジン規則にしている。宣言忘れが構造的に起きず、review→fix / improve-check→fix /
// testing→fix のどの経路でも自動で効く。
//
// capture の失敗で遷移は止めない。baseline 欠損は課題4の表に従って validator 側が扱うので、
// ここで halt すると二重に止まることになる。
function captureBaselineFor(
  root: string,
  config: WorkflowConfig,
  destId: string,
  fixAttempts: number,
  logBase: Record<string, unknown>
): void {
  const dest = config.steps[destId];
  if (!dest?.validators?.some((v) => v.type === "diff-scope")) {
    return;
  }
  const outcome = captureIfAbsent(root, config, { step: destId, fixAttempts });
  if (outcome.kind === "failed") {
    appendEvent(root, "baseline.capture-failed", { ...logBase, step: destId, fixAttempts, message: outcome.reason });
    return;
  }
  appendEvent(root, "baseline.captured", {
    ...logBase,
    step: destId,
    fixAttempts,
    reused: outcome.kind === "already-current",
    headSha: outcome.baseline.headSha ? outcome.baseline.headSha.slice(0, 8) : null,
    dirtyCount: outcome.baseline.dirty.length,
    checkRepoRoot: outcome.baseline.checkRepoRoot
  });
}

// implementation の diff-scope は report 宣言なのでフローを止めない。その代わり
// scope-violation-report.md を書き、review の optional input として渡す
// （workflow.yaml に宣言済み）。
//
// 違反が無いときは**必ず消す**。前ステップのレポートが残っていると、review は
// 解決済みの違反を現在のものとして読む。古い成果物が残ることで嘘になる系統の事故は
// このコードベースで繰り返し出ているので、書くのと同じ経路で消す。
function writeScopeViolationReport(root: string, validation: ValidationOutcome): void {
  const file = path.join(path.resolve(root), "scope-violation-report.md");
  const result = validation.results.find((r) => r.type === "diff-scope");
  if (!result) {
    return; // このステップは diff-scope を宣言していない。触らない
  }
  const detail = result.detail as
    | {
        checkRepoRoot?: string;
        declarationSource?: string;
        declarationSection?: string;
        capturedAt?: string;
        headMoved?: { baselineSha: string | null; currentSha: string | null } | null;
        declaredCount?: number;
        violations?: Array<{ path: string; kind: string; state: string }>;
      }
    | undefined;

  if (result.status !== "failed" || !detail?.violations?.length) {
    rmSync(file, { force: true });
    return;
  }

  const lines = [
    "# Scope Violation Report",
    "",
    "## Checked Repository",
    "",
    `- ${detail.checkRepoRoot ?? "(unresolved)"}`,
    "- ネストしたリポジトリと gitignore 済みパスは検査対象外（v1 は1タスク1リポジトリ）",
    "",
    "## Declaration",
    "",
    `- 宣言源: ${detail.declarationSource ?? "?"} の \`${detail.declarationSection ?? "?"}\``,
    `- 宣言件数: ${detail.declaredCount ?? 0}`,
    `- baseline 取得時刻: ${detail.capturedAt ?? "?"}`,
    detail.headMoved
      ? `- タスク中に HEAD が動いた（${detail.headMoved.baselineSha ?? "(none)"} → ${detail.headMoved.currentSha ?? "(none)"}）。コミット自体は違反ではない`
      : "- タスク中の HEAD 移動なし",
    "",
    "## Violations",
    "",
    "| path | kind | git state |",
    "|---|---|---|",
    ...detail.violations.map((v) => `| \`${v.path}\` | ${v.kind} | \`${v.state}\` |`),
    "",
    "`modified-since` は baseline 取得時点で既に変更があったファイル。",
    "**人間の並行編集の可能性がある**（git は変更の作者を記録しないため帰属は判別できない）。",
    ""
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

// verify-local が落ちたら test-report.md を書き、review / fix へ渡す（workflow.yaml に
// 入力として宣言済み）。onViolation は report なのでフローは止まらず、review が
// fix-required を返せば既存の fix ループ（fixAttempts で有界）に乗る。
//
// scope-violation-report.md と同じく、**通ったときは消す**。前ステップのレポートが残ると
// review は解決済みの失敗を現在のものとして読む。
function writeVerifyLocalReport(root: string, validation: ValidationOutcome): void {
  const file = path.join(path.resolve(root), "test-report.md");
  const result = validation.results.find((r) => r.type === "verify-local");
  if (!result) {
    return; // このステップは verify-local を宣言していない。触らない
  }
  const d = result.detail as
    | { command?: string; cwd?: string; exitCode?: number | null; fileCount?: number | null; durationMs?: number; notChecked?: string | null; output?: string }
    | undefined;

  if (result.status !== "failed" || !d) {
    rmSync(file, { force: true });
    return;
  }

  const lines = [
    "# Verify Local Report",
    "",
    "## Checked Scope",
    "",
    `- コマンド: \`${d.command}\``,
    `- 実行ディレクトリ: \`${d.cwd}\``,
    `- 走査ファイル数: ${d.fileCount ?? "?"}`,
    `- 所要: ${d.durationMs === undefined ? "?" : (d.durationMs / 1000).toFixed(1)}s`,
    d.notChecked ? `- **検査していない範囲: ${d.notChecked}**` : "- 検査対象外の宣言なし",
    "",
    "## Result",
    "",
    `終了コード ${d.exitCode ?? "?"} で失敗しました。`,
    "",
    "```text",
    (d.output ?? "")
      .split(/\r?\n/)
      .filter((l) => /\)\s*:\s*error\s/i.test(l))
      .slice(0, 50)
      .join("\n") || "(エラー行を抽出できませんでした。全文は Event Log を参照)",
    "```",
    ""
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function haltState(root: string, base: EngineState, reason: HaltedReason, keepPending = false): void {
  writeState(root, {
    ...base,
    status: "halted",
    haltedReason: reason,
    pendingApproval: null,
    pendingTransition: keepPending ? base.pendingTransition : null
  });
}

// §7.7 steps 2–10. Persists all state changes itself; safe to re-enter from step 2 (Resumability).
export function processCompletion(
  root: string,
  config: WorkflowConfig,
  state: EngineState,
  stepId: string,
  opts: CompletionOptions = {}
): PipelineOutcome {
  const step = getStep(config, stepId);
  const statusFile = config.settings.statusFile;
  const vinfo = versionInfo(root, config, stepId);
  const logBase = {
    featureId: state.featureId,
    taskId: state.taskId,
    step: stepId,
    fixAttempts: state.fixAttempts,
    ...vinfo
  };

  // 2 + 3 (+ content validators). runValidators enforces file-exists → schema/contract → token.
  opts.onValidate?.(); // observability seam: proves whether the validation phase was entered
  const validation = runValidators(root, config, step.validators, {
    stepId,
    fixAttempts: state.fixAttempts
  });
  // Full picture first (passed/failed/skipped), then one event per violation. `aiw status
  // --summary` reads the former; the latter keeps the existing per-violation records intact.
  appendEvent(root, "validation.completed", {
    ...logBase,
    results: validation.results,
    skipped: validation.results.filter((r) => r.status === "skipped").map((r) => r.type)
  });
  for (const v of validation.violations) {
    appendEvent(root, "validation.failed", { ...logBase, validator: v.type, onViolation: v.onViolation, message: v.message });
  }
  const notice = buildNotice(validation);
  writeScopeViolationReport(root, validation);
  writeVerifyLocalReport(root, validation);
  if (validation.halt) {
    const first = validation.violations.find((v) => v.onViolation === "halt");
    haltState(root, state, "validation-failed");
    appendEvent(root, "workflow.halted", { ...logBase, haltedReason: "validation-failed", message: first?.message });
    return { kind: "halted", step: stepId, reason: "validation-failed", message: first?.message ?? "validation failed" };
  }

  // status is guaranteed present by the file-exists validator, but guard defensively.
  const status = readStatus(root, statusFile);
  if (!status) {
    haltState(root, state, "validation-failed");
    appendEvent(root, "workflow.halted", { ...logBase, haltedReason: "validation-failed", message: `${statusFile} missing` });
    return { kind: "halted", step: stepId, reason: "validation-failed", message: `${statusFile} missing` };
  }

  // 4: status.step must match the executing step.
  if (status.step !== stepId) {
    haltState(root, state, "invalid-status");
    appendEvent(root, "workflow.halted", {
      ...logBase,
      haltedReason: "invalid-status",
      message: `status.step "${status.step}" != executing step "${stepId}"`
    });
    return {
      kind: "halted",
      step: stepId,
      reason: "invalid-status",
      message: `status.step "${status.step}" does not match executing step "${stepId}"`,
      detail: { statusStep: status.step }
    };
  }

  // 5: status.result must be a declared transition key.
  const transition = step.transitions[status.result];
  if (!transition) {
    haltState(root, state, "invalid-status");
    appendEvent(root, "workflow.halted", {
      ...logBase,
      haltedReason: "invalid-status",
      message: `result "${status.result}" is not a transition of "${stepId}"`
    });
    return {
      kind: "halted",
      step: stepId,
      reason: "invalid-status",
      message: `result "${status.result}" is not a declared transition of step "${stepId}"`,
      detail: { result: status.result, allowed: Object.keys(step.transitions) }
    };
  }

  // 5b (§5.8): a `feature-continue` nextPhaseId must name a phase in feature.md's Phase list.
  // Runs in the validation phase (before step 8) so an invalid nextPhaseId never triggers
  // archiveArtifacts/restoreTemplates. advancePhase remains a plain writer of the validated value.
  if (status.result === "feature-continue") {
    const phases = parseFeaturePhases(root);
    const known = phases !== null && status.nextPhaseId != null && phases.includes(status.nextPhaseId);
    if (!known) {
      haltState(root, state, "invalid-status");
      appendEvent(root, "workflow.halted", {
        ...logBase,
        haltedReason: "invalid-status",
        message: `nextPhaseId "${status.nextPhaseId ?? ""}" is not in feature.md Phase list`
      });
      return {
        kind: "halted",
        step: stepId,
        reason: "invalid-status",
        message: `nextPhaseId "${status.nextPhaseId ?? ""}" is not a phase in feature.md's Phase list`,
        detail: { nextPhaseId: status.nextPhaseId ?? null, phases }
      };
    }
  }

  // 6: approval (timing: after). Block here until approve/reject.
  if (step.approval?.required && step.approval.timing === "after" && !opts.approvalGranted) {
    writeState(root, { ...state, status: "awaiting-approval", pendingApproval: stepId });
    appendEvent(root, "step.completed", { ...logBase, result: status.result, awaitingApproval: true });
    return { kind: "awaiting-approval", step: stepId, notice };
  }

  // 7: destination + retry (§7.6). Increment happens here, on confirmed entry to a retry step.
  const destId = transition.next;
  const destStep = config.steps[destId];
  const draft: EngineState = {
    ...state,
    status: "ready",
    haltedReason: null,
    pendingApproval: null,
    pendingTransition: null
  };
  let isRetry = false;
  if (destStep?.retryPolicy) {
    const policy = destStep.retryPolicy;
    isRetry = isRetryEntry(status.result, policy);
    const evalr = evaluateRetry(state.fixAttempts, policy);
    if (evalr.escalate) {
      haltState(root, state, "escalation");
      appendEvent(root, "workflow.halted", {
        ...logBase,
        haltedReason: "escalation",
        destination: destId,
        attempted: evalr.nextAttempt,
        cap: policy.maxRetries + 1
      });
      return {
        kind: "halted",
        step: stepId,
        reason: "escalation",
        message: `retry budget exhausted for "${destId}" (attempt ${evalr.nextAttempt} > ${policy.maxRetries + 1})`,
        detail: { destination: destId }
      };
    }
    draft.fixAttempts = evalr.nextAttempt; // increment at confirmed Fix entry
  }

  // test seam: crash before commit (state uncommitted, currentStep still old).
  if (opts.faultBeforeCommit) {
    throw new Error("injected fault before commit (step 9)");
  }

  // 8: postActions (idempotent, checkpointed for resume). Never runs before 2–5 pass.
  const registry = opts.postActions ?? defaultPostActions;
  const names = step.postActions ?? [];
  if (names.length > 0) {
    const pending: PendingTransition = {
      from: stepId,
      to: destId,
      result: status.result,
      isRetry,
      completedPostActions: [],
      nextPhaseId: status.nextPhaseId ?? null
    };
    draft.pendingTransition = pending;
    writeState(root, draft); // checkpoint: currentStep still old
    const ctx: PostActionContext = {
      root,
      config,
      step,
      status,
      result: status.result,
      nextPhaseId: status.nextPhaseId ?? null,
      draft
    };
    const failure = runPostActions(root, registry, names, ctx, pending, draft, logBase);
    if (failure) {
      return failure;
    }
  }

  // 9: commit the transition.
  commitTransition(root, draft, stepId, destId);
  captureBaselineFor(root, config, destId, draft.fixAttempts, logBase);

  // 10: log.
  appendEvent(root, "step.completed", { ...logBase, result: status.result, fixAttempts: draft.fixAttempts, isRetry });
  appendEvent(root, "transition", { ...logBase, from: stepId, to: destId, result: status.result, isRetry, fixAttempts: draft.fixAttempts });
  return { kind: "transitioned", from: stepId, to: destId, result: status.result, isRetry, notice };
}

// Runs postActions from where `pending.completedPostActions` left off. Returns a halted
// outcome on failure (state persisted), or null on success.
function runPostActions(
  root: string,
  registry: PostActionRegistry,
  names: string[],
  ctx: PostActionContext,
  pending: PendingTransition,
  draft: EngineState,
  logBase: Record<string, unknown>
): PipelineOutcome | null {
  for (const name of names) {
    if (pending.completedPostActions.includes(name)) {
      continue; // already done (resume / idempotency)
    }
    const fn = registry[name];
    if (!fn) {
      draft.status = "halted";
      draft.haltedReason = "post-action-failed";
      writeState(root, draft);
      appendEvent(root, "step.failed", { ...logBase, postAction: name, message: "unknown postAction" });
      appendEvent(root, "workflow.halted", { ...logBase, haltedReason: "post-action-failed", postAction: name });
      return { kind: "halted", step: pending.from, reason: "post-action-failed", message: `unknown postAction "${name}"` };
    }
    try {
      fn(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      draft.status = "halted";
      draft.haltedReason = "post-action-failed";
      draft.pendingTransition = pending; // keep progress for resume
      writeState(root, draft);
      appendEvent(root, "step.failed", { ...logBase, postAction: name, message });
      appendEvent(root, "workflow.halted", { ...logBase, haltedReason: "post-action-failed", postAction: name, message });
      return { kind: "halted", step: pending.from, reason: "post-action-failed", message: `postAction "${name}" failed: ${message}`, detail: { postAction: name } };
    }
    pending.completedPostActions.push(name);
    draft.pendingTransition = pending;
    writeState(root, draft); // persist progress after each action
  }
  return null;
}

function commitTransition(root: string, draft: EngineState, fromId: string, toId: string): void {
  writeState(root, {
    ...draft,
    pendingTransition: null,
    lastCompletedStep: fromId,
    currentStep: toId,
    status: "ready",
    haltedReason: null,
    pendingApproval: null
  });
}

// Resume after an interruption (§7.7 / §11-9). Three cases:
//  - checkpoint present (post-action phase) → continue postActions, then commit (does NOT re-run 2–7).
//  - halted → re-run the completion pipeline from step 2 for the current step.
//  - clean interruption (no checkpoint, not halted) → re-validate from step 2 if a matching status exists.
export function resume(root: string, config: WorkflowConfig, opts: CompletionOptions = {}): PipelineOutcome {
  const state = readState(root);

  if (state.pendingTransition) {
    const pending = state.pendingTransition;
    appendEvent(root, "workflow.resumed", { step: pending.from, to: pending.to, from: "post-action-checkpoint" });
    const step = getStep(config, pending.from);
    const draft: EngineState = { ...state, status: "running", haltedReason: null };
    const reconstructed: Status = { step: pending.from, result: pending.result, reason: "resumed", nextPhaseId: pending.nextPhaseId ?? null };
    const ctx: PostActionContext = { root, config, step, status: reconstructed, result: pending.result, nextPhaseId: pending.nextPhaseId ?? null, draft };
    const registry = opts.postActions ?? defaultPostActions;
    const vinfo = versionInfo(root, config, pending.from);
    const logBase = { featureId: state.featureId, taskId: state.taskId, step: pending.from, fixAttempts: draft.fixAttempts, ...vinfo };
    const failure = runPostActions(root, registry, step.postActions ?? [], ctx, pending, draft, logBase);
    if (failure) {
      return failure;
    }
    commitTransition(root, draft, pending.from, pending.to);
    captureBaselineFor(root, config, pending.to, draft.fixAttempts, logBase);
    appendEvent(root, "step.completed", { ...logBase, result: pending.result, isRetry: pending.isRetry, resumed: true });
    appendEvent(root, "transition", { ...logBase, from: pending.from, to: pending.to, result: pending.result, isRetry: pending.isRetry });
    return { kind: "transitioned", from: pending.from, to: pending.to, result: pending.result, isRetry: pending.isRetry };
  }

  if (state.status === "halted") {
    appendEvent(root, "workflow.resumed", { step: state.currentStep, haltedReason: state.haltedReason });
    // clear the halt and re-attempt the current step from step 2 (human presumably fixed inputs).
    const cleared = writeAndRead(root, { ...state, status: "ready", haltedReason: null });
    return processCompletion(root, config, cleared, cleared.currentStep, opts);
  }

  const status = readStatus(root, config.settings.statusFile);
  if (status && status.step === state.currentStep) {
    appendEvent(root, "workflow.resumed", { step: state.currentStep, from: "clean-interruption" });
    return processCompletion(root, config, state, state.currentStep, opts);
  }

  return { kind: "nothing", message: "nothing to resume" };
}

function writeAndRead(root: string, state: EngineState): EngineState {
  writeState(root, state);
  return readState(root);
}

export function writeRejectionNote(root: string, reason: string): string {
  const file = path.join(path.resolve(root), "rejection-note.md");
  writeFileSync(file, `# Rejection Note\n\n${reason}\n`, "utf8");
  return file;
}
