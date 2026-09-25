import path from "node:path";
import { findClaudeRunFile } from "./claudeLog.js";
import { findRunFile } from "./codexLog.js";

export type RunProvider = "codex" | "claude";
export type LatestRun = { provider: RunProvider; file: string };

/** codex / claude の両方から、ステップの直近の実行を選ぶ。同名なら claude を選ぶ。 */
export function findLatestRun(root: string, step: string): LatestRun | null {
  const codex = findRunFile(root, step);
  const claude = findClaudeRunFile(root, step);
  if (!codex && !claude) {
    return null;
  }
  if (!codex) {
    return { provider: "claude", file: claude! };
  }
  if (!claude) {
    return { provider: "codex", file: codex };
  }
  return path.basename(claude) >= path.basename(codex)
    ? { provider: "claude", file: claude }
    : { provider: "codex", file: codex };
}
