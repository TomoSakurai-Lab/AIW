// claude executor — M3 で実装する（Agent SDK の query() をステップごとに1回、fresh session 固定。
// 成果物本文は埋め込まずファイルパスだけを渡す）。現時点はスタブ。
import type { ExecutorName } from "../types.js";
import { notImplemented, type ExecutorResult, type StepExecutor } from "./types.js";

export const claudeExecutor: StepExecutor = {
  name: "claude" as ExecutorName,
  async execute(): Promise<ExecutorResult> {
    return notImplemented("claude", "M3");
  }
};
