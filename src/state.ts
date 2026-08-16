import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { WorkflowContext } from "./files.js";

export type AiwStep =
  | "idle"
  | "research"
  | "codex-running"
  | "review"
  | "fix"
  | "improve-check"
  | "reflection"
  | "done";

export type AiwState = {
  featureId: string;
  phase: string;
  currentStep: AiwStep | string;
  claudeSessionPolicy: string;
  codexSessionPolicy: string;
  lastClaudeMessageAt: string | null;
  codexRunning: boolean;
  heartbeatIntervalMinutes: number;
};

export const DEFAULT_STATE: AiwState = {
  featureId: "",
  phase: "single",
  currentStep: "idle",
  claudeSessionPolicy: "feature",
  codexSessionPolicy: "task",
  lastClaudeMessageAt: null,
  codexRunning: false,
  heartbeatIntervalMinutes: 8
};

function statePath(ctx: WorkflowContext): string {
  return path.join(ctx.workflowDir, "state.json");
}

export async function readState(ctx: WorkflowContext): Promise<AiwState> {
  const filePath = statePath(ctx);

  if (!existsSync(filePath)) {
    await writeState(ctx, DEFAULT_STATE);
    return { ...DEFAULT_STATE };
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read .ai-workflow/state.json: ${formatError(error)}`);
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AiwState>;
    return {
      ...DEFAULT_STATE,
      ...parsed
    };
  } catch (error) {
    throw new Error(
      `.ai-workflow/state.json is not valid JSON. Fix it or delete it so aiw can recreate it: ${formatError(error)}`
    );
  }
}

export async function writeState(ctx: WorkflowContext, state: AiwState): Promise<void> {
  await mkdir(ctx.workflowDir, { recursive: true });
  await writeFile(statePath(ctx), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function updateState(
  ctx: WorkflowContext,
  patch: Partial<AiwState>
): Promise<AiwState> {
  const current = await readState(ctx);
  const next = {
    ...current,
    ...patch
  };
  await writeState(ctx, next);
  return next;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
