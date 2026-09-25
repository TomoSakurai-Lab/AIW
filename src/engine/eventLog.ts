import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { rootPaths } from "./paths.js";

export type EventType =
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "exec.started"
  | "exec.completed"
  | "exec.failed"
  // One per validation phase, carrying every validator's status (passed/failed/skipped). This is
  // the only place a *skipped* validator is recorded — `validation.failed` covers violations only,
  // so without this a declared-but-unexecuted safety net leaves no trace anywhere.
  | "baseline.captured"
  | "baseline.capture-failed"
  | "validation.completed"
  | "validation.failed"
  | "approval.granted"
  | "approval.rejected"
  | "transition"
  | "workflow.halted"
  | "workflow.resumed"
  | "audit.suggested"
  // 遷移確定時に作った 0 バイトスタブ（M4 段階1-3）。**黙って作らない**ための記録。
  | "stub.created"
  // aiw auto（M5・docs/design-auto.md）。起動 / 再試行 / 停止 / 起動拒否。
  // ⚠️ auto は判定に関与しないので、ここに判定の結果は無い（判定の記録は run の既存イベント）。
  | "auto.started"
  | "auto.retry"
  | "auto.stopped"
  | "auto.refused";

export type EventRecord = {
  timestamp: string;
  event: EventType;
  featureId?: string | null;
  taskId?: string | null;
  step?: string;
  [key: string]: unknown;
};

// Append-only JSONL (§9). Token/cache fields are allowed to be null in Phase 1.
//
// ⚠️⚠️ **トークン欄を集計するスクリプト・レポートを書く人へ（2026-09-17・M4.4 で実測）:**
// `inputTokens` の意味は **executor ごとに違う。executor をまたいで合算・比較してはいけない。**
//   - codex:  `inputTokens` は**キャッシュ込み**（`cacheReadTokens` ⊂ `inputTokens`。実測 90/90 本で cacheRead ≤ input）。
//             課金対象の非キャッシュ入力 = inputTokens − cacheReadTokens。キャッシュ率 = cacheReadTokens / inputTokens
//   - claude: `inputTokens` は**キャッシュ別**（非キャッシュ入力だけ。実測 68/68 本で cacheRead > input。例 118 vs 4,291,144）。
//             総入力 = inputTokens + cacheReadTokens + cacheWriteTokens。キャッシュ率 = cacheReadTokens / 総入力
// 集計は必ず `executor` 列で分けてから、上の定義で揃えること。M7 レポートの「cacheRead / input」（93.9%）は codex の定義。
export function appendEvent(root: string, event: EventType, fields: Record<string, unknown> = {}): void {
  const { runsDir, eventLog } = rootPaths(root);
  mkdirSync(runsDir, { recursive: true });
  const record: EventRecord = {
    timestamp: new Date().toISOString(),
    event,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    ...fields
  };
  appendFileSync(eventLog, `${JSON.stringify(record)}\n`, "utf8");
}

export function eventLogPath(root: string): string {
  return path.join(path.resolve(root), "runs", "execution-log.jsonl");
}
