// The "Observed" half of `aiw status --summary`: what the ENGINE verified, read back from the
// Event Log.
//
// This is deliberately a separate source from summary.ts, which reads what the AI CLAIMED in its
// artifacts. Merging them would erase the distinction that matters most under unattended
// operation: "every AC says PASS" while "diff-scope reported a violation" is precisely the state a
// human must look at, and it disappears if both collapse into one number.
import { existsSync, readFileSync } from "node:fs";
import { rootPaths } from "./paths.js";
import type { ValidatorStatus } from "./validators.js";

export type ObservedValidator = {
  type: string;
  status: ValidatorStatus;
  target?: string;
  message?: string;
  skipReason?: string;
};

export type Observed = {
  /** validators from the most recent validation phase of each step in the current task */
  validators: ObservedValidator[] | null;
  /** `report` violations that did not stop the pipeline */
  reported: Array<{ validator: string; message: string }> | null;
  fixAttempts: number | null;
  /** how many events the task window covered — 0 means the task has produced no events yet */
  eventsInWindow: number | null;
  /** why the fields above are null, when they are */
  unavailable?: "no-event-log" | "unreadable-event-log";
};

type LogRecord = Record<string, unknown>;

function readEventLog(root: string): LogRecord[] | "missing" | "unreadable" {
  const { eventLog } = rootPaths(root);
  if (!existsSync(eventLog)) {
    return "missing";
  }
  let raw: string;
  try {
    raw = readFileSync(eventLog, "utf8");
  } catch {
    return "unreadable";
  }
  const out: LogRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line) as LogRecord);
    } catch {
      // A single corrupt line must not blank the whole section; skip it and keep going.
    }
  }
  return out;
}

// Events belonging to the CURRENT task.
//
// The proper key is `taskRunId`, but state.json has no such field yet (see the v1 plan's "runId は
// session と独立に持つ"). Until it exists the boundary is derived from the log: reflection is the
// only step that ends a task, so everything after the last `transition` out of reflection belongs
// to the task in progress. Swap this for a `taskRunId` equality check once the field lands.
export function currentTaskWindow(records: LogRecord[]): LogRecord[] {
  let start = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.event === "transition" && r.from === "reflection") {
      start = i + 1;
      break;
    }
  }
  return records.slice(start);
}

export function buildObserved(root: string): Observed {
  const log = readEventLog(root);
  if (log === "missing" || log === "unreadable") {
    return {
      validators: null,
      reported: null,
      fixAttempts: null,
      eventsInWindow: null,
      unavailable: log === "missing" ? "no-event-log" : "unreadable-event-log"
    };
  }

  const window = currentTaskWindow(log);

  // Keep the LAST validation.completed per step: a step re-run after a fix should report its
  // latest verdict, not its first.
  const byStep = new Map<string, ObservedValidator[]>();
  for (const r of window) {
    if (r.event !== "validation.completed" || !Array.isArray(r.results)) {
      continue;
    }
    byStep.set(String(r.step ?? ""), r.results as ObservedValidator[]);
  }

  const reported = window
    .filter((r) => r.event === "validation.failed" && r.onViolation === "report")
    .map((r) => ({ validator: String(r.validator ?? "?"), message: String(r.message ?? "") }));

  const fixAttempts = window.reduce<number | null>(
    (max, r) => (typeof r.fixAttempts === "number" ? Math.max(max ?? 0, r.fixAttempts) : max),
    null
  );

  return {
    validators: [...byStep.values()].flat(),
    reported,
    fixAttempts,
    eventsInWindow: window.length
  };
}

export function countByStatus(validators: ObservedValidator[]): Record<ValidatorStatus, number> {
  const counts: Record<ValidatorStatus, number> = { passed: 0, failed: 0, skipped: 0 };
  for (const v of validators) {
    if (v.status === "passed" || v.status === "failed" || v.status === "skipped") {
      counts[v.status]++;
    }
  }
  return counts;
}
