import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import type { WorkflowContext } from "./files.js";
import { workflowPath } from "./files.js";

export type ModelPolicyEntry = {
  model: string;
  effort: string;
  reason: string;
};

export type ModelPolicy = Record<string, ModelPolicyEntry>;

export const MODEL_POLICY_FILE = "model-policy.json";

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  "task-planning": {
    model: "Claude Sonnet",
    effort: "low",
    reason: "タスク分割とPhase判定のみ。深い調査はしない。"
  },
  research: {
    model: "Claude Sonnet",
    effort: "medium",
    reason: "必要情報を調査し、context-packageとcodex-promptを生成する。"
  },
  implementation: {
    model: "Codex",
    effort: "medium",
    reason: "実装専用。context-packageとcodex-promptのみ読む。"
  },
  review: {
    model: "Claude Opus",
    effort: "high",
    reason: "仕様漏れ・設計リスク・バグ検出の価値が高い。"
  },
  fix: {
    model: "Codex",
    effort: "low",
    reason: "Fix ScopeのCritical/Majorのみ反映する。"
  },
  "improve-check": {
    model: "Claude Sonnet",
    effort: "low",
    reason: "Criticalが解消されたか確認するだけ。"
  },
  reflection: {
    model: "Claude Sonnet",
    effort: "low",
    reason: "整理・アーカイブ・learnings更新が中心。"
  },
  testing: {
    model: "Claude Sonnet",
    effort: "medium",
    reason: "E2E/仕様照合が必要な場合のみ使う。"
  }
};

/**
 * Maps a workflow state.currentStep to the corresponding model-policy phase key.
 */
const STEP_TO_PHASE: Record<string, string> = {
  idle: "task-planning",
  research: "research",
  "codex-running": "implementation",
  review: "review",
  fix: "fix",
  "improve-check": "improve-check",
  reflection: "reflection",
  done: "reflection"
};

export function phaseForStep(step: string): string | null {
  return STEP_TO_PHASE[step] ?? (step in DEFAULT_MODEL_POLICY ? step : null);
}

/**
 * Reads .ai-workflow/model-policy.json, creating it with defaults if it does not exist.
 */
export async function readModelPolicy(ctx: WorkflowContext): Promise<ModelPolicy> {
  const filePath = workflowPath(ctx, MODEL_POLICY_FILE);

  if (!existsSync(filePath)) {
    await writeModelPolicy(ctx, DEFAULT_MODEL_POLICY);
    return { ...DEFAULT_MODEL_POLICY };
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read .ai-workflow/${MODEL_POLICY_FILE}: ${formatError(error)}`);
  }

  try {
    return JSON.parse(raw) as ModelPolicy;
  } catch (error) {
    throw new Error(
      `.ai-workflow/${MODEL_POLICY_FILE} is not valid JSON. Fix it or delete it so aiw can recreate it: ${formatError(error)}`
    );
  }
}

export async function writeModelPolicy(ctx: WorkflowContext, policy: ModelPolicy): Promise<void> {
  await mkdir(ctx.workflowDir, { recursive: true });
  await writeFile(
    workflowPath(ctx, MODEL_POLICY_FILE),
    `${JSON.stringify(policy, null, 2)}\n`,
    "utf8"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
