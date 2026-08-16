import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  processCompletion,
  resume as resumePipeline,
  writeRejectionNote,
  type CompletionOptions,
  type PipelineOutcome
} from "./completion.js";
import { appendEvent } from "./eventLog.js";
import { getExecutor } from "./executors/index.js";
import type { ExecutorResult, StepExecutor } from "./executors/types.js";
import { getStep, loadWorkflow } from "./loader.js";
import { ASSETS_DIR, rootPaths } from "./paths.js";
import { readState, updateState, writeState } from "./state.js";
import { readStatus } from "./status.js";
import { DEFAULT_ENGINE_STATE, type EngineState, type Status, type WorkflowConfig, type WorkflowStep } from "./types.js";
import { versionInfo } from "./versions.js";

// Plain operational error: exits non-zero, mutates NO workflow state (distinct from a halt).
export class EngineError extends Error {}

export function initRoot(root: string, force = false): void {
  const p = rootPaths(root);
  if (existsSync(p.workflowYaml) && !force) {
    throw new EngineError(`already initialized: ${p.workflowYaml} exists (use --force to overwrite config).`);
  }
  for (const dir of [p.configDir, p.schemasDir, p.promptsDir, p.skillsDir, p.instructionsDir, p.templatesDir, p.attemptsDir, p.archiveDir, p.runsDir, p.researchDir]) {
    mkdirSync(dir, { recursive: true });
  }
  cpSync(path.join(ASSETS_DIR, "config"), p.configDir, { recursive: true });
  cpSync(path.join(ASSETS_DIR, "schemas"), p.schemasDir, { recursive: true });
  cpSync(path.join(ASSETS_DIR, "prompts"), p.promptsDir, { recursive: true });
  // M2: Skill / Instructions。assets に無ければ空のまま（宣言していなければ使われない）。
  // local-environment.md は runtime 専用なので assets には置かない（KI-01 の解消）。
  for (const [src, dest] of [
    ["skills", p.skillsDir],
    ["instructions", p.instructionsDir]
  ] as const) {
    const from = path.join(ASSETS_DIR, src);
    if (existsSync(from)) {
      cpSync(from, dest, { recursive: true });
    }
  }
  cpSync(path.join(ASSETS_DIR, "templates"), p.templatesDir, { recursive: true });
  cpSync(path.join(ASSETS_DIR, "seeds"), p.root, { recursive: true });

  // seed the working current-* files from templates
  for (const f of ["current-task.md", "current-result.md", "current-review.md"]) {
    copyFileSync(path.join(p.templatesDir, f), path.join(p.root, f));
  }
  if (!existsSync(p.eventLog)) {
    writeFileSync(p.eventLog, "", "utf8");
  }
  writeState(root, { ...DEFAULT_ENGINE_STATE });
}

export function loadConfig(root: string): WorkflowConfig {
  return loadWorkflow(root);
}

// Preconditions shared by `aiw run` and `aiw exec`: the workflow must be live, unblocked, and
// pointing at the step being asked for. Reads state; never mutates it.
function assertStepRunnable(state: EngineState, config: WorkflowConfig, stepId: string): WorkflowStep {
  if (state.status === "halted") {
    throw new EngineError(`workflow is halted (${state.haltedReason}). Use "aiw resume" or "aiw status".`);
  }
  if (state.pendingApproval) {
    throw new EngineError(`awaiting approval for "${state.pendingApproval}". Use "aiw approve" or "aiw reject <reason>".`);
  }
  const step = getStep(config, stepId); // throws Engine-style on unknown; wrap:
  if (stepId !== state.currentStep) {
    throw new EngineError(`current step is "${state.currentStep}", not "${stepId}".`);
  }
  return step;
}

// Pre-flight for a common Phase-1 timing slip, shared by `aiw run` and `aiw next`: running a step
// right after `approve` transitioned here, while current-status.json still holds the *previous*
// step's declaration. That would hit the §7.7 step-match check and halt (invalid-status). Detect
// only this benign case (status.step == the just-completed step) and return the stale step id;
// any other mismatch returns null and still falls through to the halt.
//
// Detection ONLY — the wording stays with each caller (`run` throws an imperative EngineError,
// `next` returns a suggestion). Having the predicate in two places is what let their orderings
// drift apart, so it lives here now.
//
// NOTE for M4 (`aiw auto`): on detection `run` throws an EngineError, NOT a halt — state.json is
// left untouched and status stays "ready". If `aiw auto` treats this error as retryable it will
// spin forever: run → EngineError → state unchanged → run. The auto loop must treat "an error that
// ended without advancing state" as its own stop condition.
function staleStatusStep(
  root: string,
  config: WorkflowConfig,
  state: EngineState,
  stepId: string
): string | null {
  let st: Status | null = null;
  try {
    st = readStatus(root, config.settings.statusFile);
  } catch {
    st = null; // malformed JSON: let the json-schema validator handle it in the pipeline
  }
  return st && st.step !== stepId && st.step === state.lastCompletedStep ? st.step : null;
}

export type ExecOptions = {
  executor?: StepExecutor; // test seam: bypass the registry (keeps tests off the OS clipboard)
};

// `aiw exec <step>`: resolve the step's executor and call it. Produces artifacts only —
// NO validation, NO transition, NO state.json write (§設計原則1). `aiw run` still owns all of that.
export async function execStep(
  root: string,
  config: WorkflowConfig,
  stepId: string,
  opts: ExecOptions = {}
): Promise<ExecutorResult> {
  const state = readState(root);
  const step = assertStepRunnable(state, config, stepId);
  // Note: `run`'s current-status.json pre-flight is deliberately NOT reused here. Before exec,
  // current-status.json legitimately still declares the previous step — that is the normal state,
  // not the timing slip that check exists to catch.
  const executor = opts.executor ?? getExecutor(step.executor);
  const logBase = {
    featureId: state.featureId,
    taskId: state.taskId,
    step: stepId,
    executor: executor.name,
    ...versionInfo(root, config, stepId)
  };
  appendEvent(root, "exec.started", logBase);
  let result: ExecutorResult;
  try {
    result = await executor.execute({ root, config, step });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendEvent(root, "exec.failed", { ...logBase, message });
    throw error;
  }
  appendEvent(root, result.ok ? "exec.completed" : "exec.failed", {
    ...logBase,
    outputs: result.outputs,
    message: result.error ?? null,
    meta: result.meta ?? null
  });
  return result;
}

export function runStep(root: string, config: WorkflowConfig, stepId: string, opts: CompletionOptions = {}): PipelineOutcome {
  const state = readState(root);
  const step = assertStepRunnable(state, config, stepId);
  const stale = staleStatusStep(root, config, state, stepId);
  if (stale) {
    throw new EngineError(
      `current-status.json still declares the previous step "${stale}". ` +
        `Produce "${stepId}" outputs and write current-status.json as { "step": "${stepId}", ... }, ` +
        `then re-run "aiw run ${stepId}". (No state changed; no "aiw resume" needed.)`
    );
  }
  appendEvent(root, "step.started", { featureId: state.featureId, taskId: state.taskId, step: stepId, ...versionInfo(root, config, stepId) });
  return processCompletion(root, config, state, stepId, opts);
}

export function resume(root: string, config: WorkflowConfig, opts: CompletionOptions = {}): PipelineOutcome {
  return resumePipeline(root, config, opts);
}

export function approve(root: string, config: WorkflowConfig, opts: CompletionOptions = {}): PipelineOutcome {
  const state = readState(root);
  if (!state.pendingApproval) {
    throw new EngineError("no pending approval to grant.");
  }
  const stepId = state.pendingApproval;
  appendEvent(root, "approval.granted", { step: stepId, actor: "human" });
  const cleared = updateState(root, { pendingApproval: null, status: "ready" });
  return processCompletion(root, config, cleared, stepId, { ...opts, approvalGranted: true });
}

export function reject(root: string, config: WorkflowConfig, reason: string): PipelineOutcome {
  const state = readState(root);
  if (!state.pendingApproval) {
    throw new EngineError("no pending approval to reject.");
  }
  const stepId = state.pendingApproval;
  const step = getStep(config, stepId);
  appendEvent(root, "approval.rejected", { step: stepId, actor: "human", reason });
  if (step.approval?.onReject === "halt") {
    writeState(root, { ...state, status: "halted", haltedReason: "approval-rejected", pendingApproval: null });
    appendEvent(root, "workflow.halted", { step: stepId, haltedReason: "approval-rejected", reason });
    return { kind: "halted", step: stepId, reason: "approval-rejected", message: `approval rejected: ${reason}` };
  }
  // rerun: pass the rejection reason as an added input; re-run the same step.
  writeRejectionNote(root, reason);
  updateState(root, { pendingApproval: null, status: "ready" });
  return { kind: "rerun", step: stepId };
}

export type StatusView = {
  root: string;
  currentStep: string;
  status: string;
  haltedReason: string | null;
  pendingApproval: string | null;
  fixAttempts: number;
  cleanReviewStreak: number;
  lastCompletedStep: string | null;
  role?: string;
  transitions?: string[];
};

export function statusView(root: string, config: WorkflowConfig): StatusView {
  const state = readState(root);
  const step = config.steps[state.currentStep];
  return {
    root: rootPaths(root).root,
    currentStep: state.currentStep,
    status: state.status,
    haltedReason: state.haltedReason,
    pendingApproval: state.pendingApproval,
    fixAttempts: state.fixAttempts,
    cleanReviewStreak: state.cleanReviewStreak,
    lastCompletedStep: state.lastCompletedStep,
    role: step?.role,
    transitions: step ? Object.keys(step.transitions) : undefined
  };
}

// A state id that no step defines but some transition points at — i.e. a terminal state.
function isTerminalState(config: WorkflowConfig, id: string): boolean {
  if (config.steps[id]) {
    return false;
  }
  return Object.values(config.steps).some((s) => Object.values(s.transitions).some((t) => t.next === id));
}

// `aiw next`: suggest the action for the current state (does not auto-run claude/codex work).
export function nextSuggestion(root: string, config: WorkflowConfig): { action: string; reason: string } {
  const state = readState(root);
  if (state.status === "halted") {
    return { action: "aiw resume", reason: `halted (${state.haltedReason}); fix inputs then resume, or escalate to a human.` };
  }
  if (state.pendingApproval) {
    return { action: "aiw approve | aiw reject <reason>", reason: `step "${state.pendingApproval}" is awaiting human approval.` };
  }
  if (state.pendingTransition) {
    return { action: "aiw resume", reason: "a post-action checkpoint is pending; resume to finish the transition." };
  }
  const step = config.steps[state.currentStep];
  if (!step) {
    // Terminal states (e.g. "complete") are transition destinations with no step definition.
    // Derived from the config rather than hardcoded, so a renamed terminal keeps working.
    if (isTerminalState(config, state.currentStep)) {
      return { action: "aiw new-task", reason: `workflow reached the terminal state "${state.currentStep}"; reset for the next task.` };
    }
    return { action: "aiw status", reason: `current step "${state.currentStep}" is unknown.` };
  }
  const stale = staleStatusStep(root, config, state, state.currentStep);
  if (stale) {
    return {
      action: `regenerate current-status.json for "${state.currentStep}", then aiw run ${state.currentStep}`,
      reason: `current-status.json still declares the previous step "${stale}"; produce ${step.role} outputs + a fresh current-status.json for "${state.currentStep}" first.`
    };
  }
  return {
    action: `aiw run ${state.currentStep}`,
    reason: `produce ${step.role} outputs + current-status.json for "${state.currentStep}", then run to process completion.`
  };
}
