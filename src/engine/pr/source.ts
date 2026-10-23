// aiw pr の入力（docs/design-pr.md §A-2）。**読むのは archive の成果物と Event Log と runs/ のスクショだけ。**
//
// state.json は読まない（確定済みの判断4: タスク状態に触らない）。HTTP も知らない（describe.ts / run.ts の仕事）。
// 欠けているものは null / "absent" として返し、**0 件・確認済みへ丸めない**（summary.ts と同じ三値の規律）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseDeclaredFiles } from "../declaredFiles.js";
import { completedTaskWindow, readEventLog } from "../observed.js";
import { rootPaths } from "../paths.js";
import { countListItems, countTriStatusAny, extractSection, stripHtmlComments, type TriCount } from "../sections.js";
import { parseJsonText } from "../jsonText.js";

const TASK_DIR = /^(\d{8}T\d{6})-/;

/** archive の 1 タスク分のディレクトリ（`archive/<feature or single>/<日付時刻>-<task>/`）を新しい順に。 */
export function listArchivedTaskDirs(root: string): string[] {
  const { archiveDir } = rootPaths(root);
  if (!existsSync(archiveDir)) {
    return [];
  }
  const found: Array<{ stamp: string; dir: string }> = [];
  for (const group of readdirSync(archiveDir, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(archiveDir, group.name);
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const m = entry.name.match(TASK_DIR);
      // feature.md の退避（`<日付>-feature-*.md`）や旧形式の `task` を拾わない
      if (entry.isDirectory() && m && existsSync(path.join(groupDir, entry.name, "current-task.md"))) {
        found.push({ stamp: m[1], dir: path.join(groupDir, entry.name) });
      }
    }
  }
  return found.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0)).map((f) => f.dir);
}

/** `20261020T054338` → Date（UTC）。archiveArtifacts の archiveStamp の逆。 */
export function parseArchiveStamp(stamp: string): Date | null {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

export type ReviewRecord =
  | { state: "absent" }
  | { state: "template" }
  | { state: "present"; critical: number; major: number; backlog: string[] | null };

export type ProcessRecord =
  | { state: "missing" | "unreadable" | "no-window" }
  | {
      state: "present";
      /** diff-scope の status ごとの件数（implementation / fix の最後の検証のうち、このタスクの窓にあったもの） */
      diffScope: { passed: number; failed: number; skipped: number };
      /** 修正（fix）ステップの完了回数 */
      fixRuns: number;
      /** 窓の最後の improve-check の transition が reflection へ進んだか（修正後の確認を通過したか） */
      improveCheckPassed: boolean | null;
    };

export type PrSource = {
  taskDir: string;
  stamp: string;
  taskId: string | null;
  metadata: { summary: string | null; featureName: string | null; taskName: string | null; featureId: string | null } | null;
  declared:
    | { source: "context-package"; files: string[] }
    | { source: "files-changed"; files: string[] }
    | null;
  acceptance: TriCount | null;
  manualVerification: string[] | null;
  review: ReviewRecord;
  process: ProcessRecord;
  screenshots: string[];
};

function readText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** 箇条書きがあればその各項目、無ければ空でない行（実物は散文で書かれることがある）。 */
export function sectionItems(markdown: string, spec: string): string[] | null {
  const body = extractSection(markdown, spec);
  if (body === null) {
    return null;
  }
  const lines = stripHtmlComments(body)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("|"));
  if (countListItems(body) > 0) {
    return lines.filter((l) => /^(?:[-*+]|\d+[.)])\s+\S/.test(l)).map((l) => l.replace(/^(?:[-*+]|\d+[.)])\s+/, ""));
  }
  // 「なし」の 1 行は 0 件
  return lines.filter((l) => !/^(?:なし|無し|特になし|該当なし|none)[。.]?$/i.test(l));
}

function countHeadings(markdown: string, spec: string): number {
  const body = extractSection(markdown, spec);
  if (body === null) return 0;
  return stripHtmlComments(body)
    .split(/\r?\n/)
    .filter((l) => /^###\s+\S/.test(l)).length;
}

function readReview(root: string, taskDir: string): ReviewRecord {
  const text = readText(path.join(taskDir, "current-review.md"));
  if (text === null) {
    return { state: "absent" };
  }
  const template = readText(path.join(rootPaths(root).templatesDir, "current-review.md"));
  const norm = (s: string): string => s.replace(/\r\n/g, "\n").trim();
  if ((template !== null && norm(template) === norm(text)) || norm(stripHtmlComments(text)).replace(/^#.*$/gm, "").trim() === "") {
    return { state: "template" };
  }
  const backlogBody = extractSection(text, "## Backlog");
  let backlog: string[] | null = null;
  if (backlogBody !== null) {
    backlog = [];
    for (const block of stripHtmlComments(backlogBody).split(/^###\s+/m).slice(1)) {
      // Summary は複数行にわたる（字下げした続きの行）。次の `- 項目:`・字下げの無い行・空行の手前まで（2026-10-23 実例: 1 行目だけ読んで文の途中で切れた）
      const lines = block.split(/\r?\n/);
      const at = lines.findIndex((l) => /^\s*[-*]\s+Summary\s*[:：]/.test(l));
      if (at < 0) continue;
      const parts = [lines[at].replace(/^\s*[-*]\s+Summary\s*[:：]\s*/, "")];
      for (const l of lines.slice(at + 1)) {
        if (l.trim() === "" || /^\S/.test(l) || /^\s*[-*]\s+\S/.test(l)) break;
        parts.push(l.trim());
      }
      backlog.push(parts.join(" ").trim());
    }
  }
  return { state: "present", critical: countHeadings(text, "## Critical"), major: countHeadings(text, "## Major"), backlog };
}

function readProcess(root: string, stamp: string): ProcessRecord {
  const log = readEventLog(root);
  if (log === "missing" || log === "unreadable") {
    return { state: log };
  }
  const end = parseArchiveStamp(stamp);
  const window = end ? completedTaskWindow(log, end) : null;
  if (!window) {
    return { state: "no-window" };
  }
  const lastByStep = new Map<string, Array<{ type?: string; status?: string }>>();
  let fixRuns = 0;
  let improveCheckPassed: boolean | null = null;
  for (const r of window) {
    if (r.event === "validation.completed" && Array.isArray(r.results)) {
      lastByStep.set(String(r.step ?? ""), r.results as Array<{ type?: string; status?: string }>);
    }
    if (r.event === "step.completed" && r.step === "fix" && r.awaitingApproval !== true) {
      fixRuns++;
    }
    if (r.event === "transition" && r.from === "improve-check") {
      improveCheckPassed = r.to === "reflection";
    }
  }
  const diffScope = { passed: 0, failed: 0, skipped: 0 };
  for (const step of ["implementation", "fix"]) {
    for (const v of lastByStep.get(step) ?? []) {
      if (v.type !== "diff-scope") continue;
      if (v.status === "passed") diffScope.passed++;
      else if (v.status === "failed") diffScope.failed++;
      else if (v.status === "skipped") diffScope.skipped++;
    }
  }
  return { state: "present", diffScope, fixRuns, improveCheckPassed };
}

function readMetadata(taskDir: string): PrSource["metadata"] {
  const text = readText(path.join(taskDir, "task-metadata.json"));
  if (text === null || text.trim() === "") return null;
  try {
    const v = parseJsonText(text).value as Record<string, unknown>;
    const s = (k: string): string | null => (typeof v?.[k] === "string" && (v[k] as string).trim() !== "" ? (v[k] as string).trim() : null);
    return { summary: s("summary"), featureName: s("featureName"), taskName: s("taskName"), featureId: s("featureId") };
  } catch {
    return null;
  }
}

function readDeclared(taskDir: string): PrSource["declared"] {
  const pkg = readText(path.join(taskDir, "context-package.md"));
  if (pkg !== null) {
    const parsed = parseDeclaredFiles(pkg, "## Modify");
    if (parsed.ok) {
      return { source: "context-package", files: [...parsed.files, ...parsed.dirPrefixes] };
    }
  }
  // 2026-10-20 より前の archive には context-package.md が無い（Q3）。実装の自己申告へ落とし、見出しで区別する
  const result = readText(path.join(taskDir, "current-result.md"));
  if (result !== null) {
    const parsed = parseDeclaredFiles(result, "## Files Changed");
    if (parsed.ok) {
      const files = [...parsed.files, ...parsed.dirPrefixes].filter((f) => f.includes("/") || f.includes("."));
      return { source: "files-changed", files };
    }
  }
  return null;
}

function readTaskId(taskDir: string): string | null {
  const text = readText(path.join(taskDir, "current-task.md"));
  const m = text?.match(/^\s*[-*]\s+Task ID\s*[:：]\s*`?([^`\s]+)`?/m);
  return m ? m[1] : null;
}

function listScreenshots(root: string, taskId: string | null): string[] {
  if (!taskId || !/^[\w.-]+$/.test(taskId)) {
    return [];
  }
  const dir = path.join(rootPaths(root).runsDir, taskId, "screenshots");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => /^after-.*\.png$/i.test(f) && statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => path.join(dir, f));
}

export function readPrSource(root: string, taskDir: string): PrSource {
  const stamp = path.basename(taskDir).match(TASK_DIR)?.[1] ?? "";
  const taskId = readTaskId(taskDir);
  const result = readText(path.join(taskDir, "current-result.md"));
  return {
    taskDir,
    stamp,
    taskId,
    metadata: readMetadata(taskDir),
    declared: readDeclared(taskDir),
    acceptance: result === null ? null : countTriStatusAny(result, "## Acceptance Criteria Verification"),
    manualVerification: result === null ? null : sectionItems(result, "## Manual Verification Required"),
    review: readReview(root, taskDir),
    process: readProcess(root, stamp),
    screenshots: listScreenshots(root, taskId)
  };
}
