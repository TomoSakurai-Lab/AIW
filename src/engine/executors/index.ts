// executor レジストリ。workflow.yaml の steps[].executor（ローダーが既定値を注入済み）を
// 実体へ解決する唯一の入口。
import type { ExecutorName } from "../types.js";
import { claudeExecutor } from "./claude.js";
import { clipboardExecutor } from "./clipboard.js";
import { codexExecutor } from "./codex.js";
import type { ExecutorProgress, StepExecutor } from "./types.js";

const REGISTRY: Record<ExecutorName, StepExecutor> = {
  clipboard: clipboardExecutor,
  codex: codexExecutor,
  claude: claudeExecutor
};

/**
 * 進行イベントを**画面へ**出すか（M3・課題I）。
 *
 * 既定は **codex 自身の発言（message）だけ**。shell / edit / thinking は画面へ出さない。
 * 実測: 大きめのタスク 1 本で 119 イベント・shell 36 回。全種類を流すと**画面がコマンドで
 * 埋まり、モデルが何を言っているかが読めなくなる**。
 *
 * ⚠️ **`error` は既定でも必ず出す。** 失敗を黙って通さないのはこのコードベースの一貫した規律で、
 * 「発言だけ」を字義どおり適用して例外を握り潰すのは筋が違う。
 *
 * 捨てているのは**表示だけ**。全イベントは `runs/codex/` の JSONL に残り、`--verbose` でも見られる。
 */
export function visibleOnScreen(kind: ExecutorProgress["kind"], verbose: boolean): boolean {
  return verbose || kind === "message" || kind === "error";
}

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
