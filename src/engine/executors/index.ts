// executor レジストリ。workflow.yaml の steps[].executor（ローダーが既定値を注入済み）を
// 実体へ解決する唯一の入口。
import type { ExecutorName } from "../types.js";
import { claudeExecutor } from "./claude.js";
import { clipboardExecutor } from "./clipboard.js";
import { codexExecutor } from "./codex.js";
import type { StepExecutor } from "./types.js";

const REGISTRY: Record<ExecutorName, StepExecutor> = {
  clipboard: clipboardExecutor,
  codex: codexExecutor,
  claude: claudeExecutor
};

export function getExecutor(name: ExecutorName): StepExecutor {
  const executor = REGISTRY[name];
  if (!executor) {
    // ローダーが未知の値を弾くため通常は到達しない（プログラムからの直接呼び出し用の保険）。
    throw new Error(`Unknown executor "${name}".`);
  }
  return executor;
}

export { copyStepPromptToClipboard, createClipboardExecutor, clipboardExecutor, clipboardMeta } from "./clipboard.js";
export type { ClipboardDeps, ClipboardMeta, ClipboardMode } from "./clipboard.js";
export type { ExecutorRequest, ExecutorResult, StepExecutor } from "./types.js";
