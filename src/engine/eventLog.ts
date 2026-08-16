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
  | "audit.suggested";

export type EventRecord = {
  timestamp: string;
  event: EventType;
  featureId?: string | null;
  taskId?: string | null;
  step?: string;
  [key: string]: unknown;
};

// Append-only JSONL (§9). Token/cache fields are allowed to be null in Phase 1.
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
