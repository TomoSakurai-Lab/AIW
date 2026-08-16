// codex executor — M2 で実装する（`codex exec --json` を起動し、JSONL を runs/ へ保存、
// current-result.md / current-status.json は Codex が直接更新）。現時点はスタブ。
import type { ExecutorName } from "../types.js";
import { notImplemented, type ExecutorResult, type StepExecutor } from "./types.js";

export const codexExecutor: StepExecutor = {
  name: "codex" as ExecutorName,
  async execute(): Promise<ExecutorResult> {
    return notImplemented("codex", "M2");
  }
};
