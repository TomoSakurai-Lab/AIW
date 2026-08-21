import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { currentTaskWindow, readEventLog } from "./observed.js";
import { rootPaths } from "./paths.js";
import type { EngineState, Status, WorkflowConfig, WorkflowStep } from "./types.js";

export type PostActionContext = {
  root: string;
  config: WorkflowConfig;
  step: WorkflowStep;
  status: Status;
  result: string;
  nextPhaseId?: string | null;
  draft: EngineState; // mutable; committed at pipeline step 9
};

export type PostActionFn = (ctx: PostActionContext) => void;
export type PostActionRegistry = Record<string, PostActionFn>;

function abs(root: string, rel: string): string {
  return path.join(path.resolve(root), rel);
}

// Parse the Phase list from feature.md (§6.3): the bullet items under a heading whose text
// starts with "Phase list". Each item's leading token (backticks stripped, up to whitespace
// or ':') is the phase ID. Returns null if feature.md is absent. Single source of feature.md
// phase parsing — reused by the M1 nextPhaseId validation (§5.8).
export function parseFeaturePhases(root: string): string[] | null {
  const file = abs(root, "feature.md");
  if (!existsSync(file)) {
    return null;
  }
  const phases: string[] = [];
  let inList = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      inList = heading[2].trim().toLowerCase().startsWith("phase list");
      continue;
    }
    if (!inList) {
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet) {
      const id = bullet[1].replace(/`/g, "").trim().split(/[\s:]/)[0];
      if (id) {
        phases.push(id);
      }
    }
  }
  return phases;
}

// current-result.md -> attempts/result-<n>.md. Idempotent: skip if latest snapshot is identical.
const snapshotResult: PostActionFn = ({ root }) => {
  const { attemptsDir } = rootPaths(root);
  const src = abs(root, "current-result.md");
  if (!existsSync(src)) {
    throw new Error("snapshotResult: current-result.md does not exist");
  }
  mkdirSync(attemptsDir, { recursive: true });
  const content = readFileSync(src, "utf8");
  const existing = readdirSync(attemptsDir)
    .map((f) => f.match(/^result-(\d+)\.md$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const latest = existing.at(-1);
  if (latest !== undefined && readFileSync(path.join(attemptsDir, `result-${latest}.md`), "utf8") === content) {
    return; // already snapshotted this exact content
  }
  const nextIndex = (latest ?? 0) + 1;
  writeFileSync(path.join(attemptsDir, `result-${nextIndex}.md`), content, "utf8");
};

// Timestamp component for the archive path: 20260804T163000 (UTC, filename-safe).
function archiveStamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

// Copy attempts/ + current-* into archive/<feature>/<timestamp>-<task>/.
//
// The timestamp is what makes the destination unique. Before it, the path was
// archive/<featureId ?? "single">/<taskId ?? "task">, and featureId/taskId are null in practice,
// so every task resolved to archive/single/task — where an `existsSync(dest)` early return then
// skipped the copy silently. Measured on the live root: 31 completed reflections, 2 archive
// directories, the newest file from the first day. ~30 tasks' artifacts were never written and
// are not recoverable.
//
// Re-running for the same task creates a second directory rather than overwriting one; that is a
// deliberate trade. Idempotency across a resume is already guaranteed by
// pendingTransition.completedPostActions, so this action does not need its own guard — and a
// guard that silently returns success is exactly how the data was lost.
const archiveArtifacts: PostActionFn = ({ root, draft }) => {
  const { archiveDir, attemptsDir } = rootPaths(root);
  const feature = draft.featureId ?? "single";
  const task = draft.taskId ?? "task";
  const dest = path.join(archiveDir, feature, `${archiveStamp()}-${task}`);
  mkdirSync(dest, { recursive: true });
  for (const f of [
    "user-task.md",
    "current-task.md",
    "research-findings.md", // M1: current-review.md の監査が参照した findings を残す
    "current-result.md",
    "current-review.md",
    "current-status.json",
    "task-metadata.json"
  ]) {
    const src = abs(root, f);
    if (existsSync(src)) {
      copyFileSync(src, path.join(dest, f));
    }
  }
  if (existsSync(attemptsDir)) {
    cpSync(attemptsDir, path.join(dest, "attempts"), { recursive: true });
  }
  archiveCodexRuns(root, dest);
};

/**
 * このタスクで走った codex の JSONL を archive へ随伴させる（M3・B2）。
 *
 * 目的は M7 の追跡（「一回の失敗を後から追える」）。成果物だけが archive にあっても、
 * **その実装が何をしたか**は JSONL にしか無い。タスクの記録が2箇所に分かれていると、
 * 半年後に照合できない。
 *
 * ⚠️ **copy であって move ではない。** `runs/codex/` は残す:
 *   - `aiw log` は runs/ だけを見る（移すと直近の実行が読めなくなる）
 *   - 退避中に落ちてもディスク上の一次資料が消えない
 * 保持方針は「全保存」なので、二重に持つコストは受け入れる（1 実行あたり最大 441 KB の実測）。
 *
 * どれがこのタスクの分かは **Event Log のタスク窓**（最後の reflection 遷移以降）から決める。
 * mtime やファイル名の推測に頼らない。窓の定義は observed.ts と同じものを使う。
 */
function archiveCodexRuns(root: string, dest: string): void {
  const log = readEventLog(root);
  if (log === "missing" || log === "unreadable") {
    return; // Event Log が読めないなら何が今回の分か決められない。黙って何もしない方が安全
  }
  const files = new Set<string>();
  for (const r of currentTaskWindow(log)) {
    const rel = (r as { meta?: { jsonl?: unknown; lastMessage?: unknown } }).meta;
    for (const key of ["jsonl", "lastMessage"] as const) {
      const value = rel?.[key];
      if (typeof value === "string" && value !== "") {
        files.add(value);
      }
    }
  }
  if (files.size === 0) {
    return; // clipboard だけで回したタスクには JSONL が無い（欠落ではなく正常）
  }
  const runsDest = path.join(dest, "runs");
  mkdirSync(runsDest, { recursive: true });
  for (const rel of files) {
    const src = abs(root, rel);
    if (existsSync(src)) {
      copyFileSync(src, path.join(runsDest, path.basename(src)));
    }
  }
}

// Restore working docs from templates/. Idempotent by overwrite. current-task/result/review and
// research-findings are reset every reflection; user-task.md (the human input) is reset ONLY on
// feature-complete — on feature-continue the overall request must persist for the next phase's
// Task Planning. Runs AFTER archiveArtifacts (workflow.yaml postActions order), so every file
// blanked here has already been copied into archive/<feature>/<task>/.
//
// task-metadata.json is deliberately NOT here — see discardTaskMetadata below.
const restoreTemplates: PostActionFn = ({ root, result }) => {
  const { templatesDir } = rootPaths(root);
  const files = [
    "current-task.md",
    "research-findings.md", // M1: 次タスクの research が上書きする前に必ず退避されている
    "current-result.md",
    "current-review.md"
  ];
  if (result === "feature-complete") {
    files.push("user-task.md");
  }
  for (const f of files) {
    const tmpl = path.join(templatesDir, f);
    if (!existsSync(tmpl)) {
      throw new Error(`restoreTemplates: template ${f} not found`);
    }
    copyFileSync(tmpl, abs(root, f));
  }
};

// Delete task-metadata.json after it has been archived. Idempotent (no-op when already gone).
//
// task-metadata.json has a different lifecycle from the current-*.md working docs. Those are
// "the container you work in", so restoring a blank template makes sense. This one is "the record
// OF that task" — the next task inherits nothing from it. Leaving a blank template behind would
// satisfy reflection's file-exists validator without anyone writing the metrics, which is exactly
// the silent gap the validator was added to close (M1 レビュー A-7). Deleting it instead forces
// every reflection to produce a fresh file.
const discardTaskMetadata: PostActionFn = ({ root }) => {
  rmSync(abs(root, "task-metadata.json"), { force: true });
};

// Reset the shared Fix budget on the committed state draft.
const resetFixAttempts: PostActionFn = ({ draft }) => {
  draft.fixAttempts = 0;
};

// feature-continue only: update "Current phase" in feature.md. Idempotent.
const advancePhase: PostActionFn = ({ root, result, nextPhaseId, draft }) => {
  if (result !== "feature-continue" || !nextPhaseId) {
    return;
  }
  const file = abs(root, "feature.md");
  const line = `Current phase: ${nextPhaseId}`;
  let content = existsSync(file) ? readFileSync(file, "utf8") : "# Feature\n";
  if (/^Current phase:.*$/m.test(content)) {
    content = content.replace(/^Current phase:.*$/m, line);
  } else {
    content = `${content.trimEnd()}\n\n${line}\n`;
  }
  writeFileSync(file, content, "utf8");
  draft.phase = nextPhaseId;
};

export const defaultPostActions: PostActionRegistry = {
  snapshotResult,
  discardTaskMetadata,
  archiveArtifacts,
  restoreTemplates,
  resetFixAttempts,
  advancePhase
};
