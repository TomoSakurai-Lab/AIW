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

/**
 * ブランチ名とタスクの記録の照合（2026-10-23・設計 §E-5）。比べるのは「接頭辞を除いた小文字の名前」:
 *   ブランチ `feature/review-feedback-1023`（`feature/` `feat/` `task/` を除く）
 *   ↔ feature のフォルダ `<日付時刻>-FEAT-review-feedback-1023`（日付時刻と `FEAT-` を除く。日付なしの旧形式も同じ）
 *   ↔ 単一タスク（`archive/single/`）は Task ID `TASK-2026-10-20-x`（`TASK-` を除く）
 */
export function branchKey(branch: string): string {
  return branch.replace(/^refs\/heads\//, "").replace(/^(?:feature|features|feat|task|tasks)\//i, "").toLowerCase();
}

/** そのタスクの記録に対応するブランチのキー（feature のタスクは feature ID、単一タスクは Task ID から）。決められなければ null */
export function taskDirKey(taskDir: string): string | null {
  const group = path.basename(path.dirname(taskDir));
  if (group !== "single") {
    const featureId = group.replace(/^\d{8}T\d{6}-/, "");
    return featureId.replace(/^FEAT-/i, "").toLowerCase() || null;
  }
  const taskId = readTaskId(taskDir);
  return taskId ? taskId.replace(/^TASK-/i, "").toLowerCase() : null;
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

/** 依頼文（user-task.md）のチェックボックスの項目を、見出し（画面 / タブ）ごとに。§A-6 */
export type RequestGroup = { heading: string; items: Array<{ text: string; sub: string[] }> };

/** 名前で対にした変更前 / 変更後のスクショ（絶対パス）。§A-6 */
export type ShotPair = {
  name: string;
  before: string | null;
  after: string | null;
  /** `screenshots/labels.json` の日本語のラベル（依頼の見出しと同じ書き方。例: `工種別予算管理表 / 取極（実績）タブ`）。無ければ null */
  label: string | null;
};

export type PrSource = {
  taskDir: string;
  stamp: string;
  taskId: string | null;
  /** null = user-task.md が無い。[] = チェックボックスの項目が無い。作業の進め方の見出し（processHeadings）は除いた後 */
  requested: RequestGroup[] | null;
  /** 依頼文から外した、作業の進め方の見出し（確認・進め方・backlog の扱いなど）。stdout に出すため */
  processHeadings: string[];
  /** 依頼文の題（`## 次タスク：…` の「…」、無ければ最初の `## `）。PR のタイトルに使う */
  requestTitle: string | null;
  /** feature の全タスク（このタスクまで）の runs/<Task ID>/screenshots/ の before-* / after-* */
  shots: ShotPair[];
  metadata: { summary: string | null; featureName: string | null; taskName: string | null; featureId: string | null } | null;
  declared:
    | { source: "context-package"; files: string[] }
    | { source: "files-changed"; files: string[] }
    | null;
  acceptance: TriCount | null;
  manualVerification: string[] | null;
  review: ReviewRecord;
  process: ProcessRecord;
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

/**
 * 依頼文のチェックボックス（`- [ ]` / `- [x]`）を「何を変えるか」として読む（2026-10-23・§A-6）。
 * 進め方・完了条件はチェックボックスでない箇条書きで書かれる（実物で確認）ので拾わない。
 * 見出しは `###` 以下を「 / 」でつなぎ、先頭の番号（`1. `）を除く。チェックボックスより深い字下げの箇条書きは子項目。
 */
export function parseRequested(markdown: string): RequestGroup[] {
  const groups: RequestGroup[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let current: RequestGroup["items"][number] | null = null;
  let currentIndent = -1;
  for (const line of stripHtmlComments(markdown).split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      const level = h[1].length;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: h[2].replace(/^\d+[.)．]\s*/, "").trim() });
      current = null;
      continue;
    }
    const box = line.match(/^(\s*)[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/);
    if (box) {
      const path3 = stack.filter((s) => s.level >= 3).map((s) => s.text);
      const heading = (path3.length > 0 ? path3 : stack.slice(-1).map((s) => s.text)).join(" / ");
      let group = groups.find((g) => g.heading === heading);
      if (!group) {
        group = { heading, items: [] };
        groups.push(group);
      }
      current = { text: box[2], sub: [] };
      currentIndent = box[1].length;
      group.items.push(current);
      continue;
    }
    // 子項目は箇条書きか番号付き（実物: 帳票の 3 種類が `  1. …`）。印はそのまま残す
    const sub = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+?)\s*$/);
    if (sub && current && sub[1].length > currentIndent) {
      current.sub.push(`${/^\d/.test(sub[2]) ? sub[2] : "-"} ${sub[3]}`);
      continue;
    }
    if (line.trim() !== "" && !/^\s/.test(line)) current = null; // 字下げの無い地の文で項目は終わる
  }
  return groups;
}

/**
 * `runs/<Task ID>/screenshots/labels.json`（2026-10-23・§A-6b）: `{ "<名前>": "<日本語のラベル>" }`。
 * 名前は `before-<名前>.png` / `after-<名前>.png` の <名前>。無い・壊れている・文字列でない値は無視（ラベル無しとして扱う）
 */
function readLabels(root: string, taskId: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!taskId || !/^[\w.-]+$/.test(taskId)) return out;
  const text = readText(path.join(rootPaths(root).runsDir, taskId, "screenshots", "labels.json"));
  if (text === null) return out;
  try {
    const v = parseJsonText(text).value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, label] of Object.entries(v as Record<string, unknown>)) {
        if (typeof label === "string" && label.trim() !== "") out.set(k, label.trim());
      }
    }
  } catch {
    // 壊れた labels.json はラベル無しとして扱う（--dry-run で「ラベルの無い画像」として見える）
  }
  return out;
}

/**
 * 作業の進め方の見出しか（客先向けの「対応した内容」に入れない）。見出しの最後の段で判定する。
 * 2026-10-27 実例: 「### 5. 確認」のチェックボックス（「spec が通る」「スクショで確かめる」）が PR の説明文に入った
 */
export function isProcessHeading(heading: string): boolean {
  const last = heading.split("/").pop()!.trim();
  return /^(?:動作)?確認$|^検証|完了条件|進め方|^backlog|^バックログ|^テスト/i.test(last);
}

/** 依頼文の題: `## 次タスク：…` の「…」。無ければ最初の `## ` の見出し。どちらも無ければ null */
export function requestTitleOf(markdown: string): string | null {
  const h2 = stripHtmlComments(markdown)
    .split(/\r?\n/)
    .map((l) => l.match(/^##\s+(.+?)\s*$/)?.[1])
    .filter((x): x is string => Boolean(x));
  const first = h2[0];
  if (!first) return null;
  return first.replace(/^次タスク\s*[:：]\s*/, "").trim() || null;
}

function shotsOf(root: string, taskId: string | null): string[] {
  if (!taskId || !/^[\w.-]+$/.test(taskId)) return [];
  const dir = path.join(rootPaths(root).runsDir, taskId, "screenshots");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^(?:before|after)-.+\.png$/i.test(f) && statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * feature の全タスク（このタスクまで・古い順）のスクショを名前で対にする。変更前は**最初に撮ったもの**、
 * 変更後は**最後に撮ったもの**（feature = ブランチ = PR なので、PR 全体の変更前 → 変更後）。単一タスクはそのタスクだけ。
 */
function collectShots(root: string, taskDir: string, taskId: string | null, ownOnly = false): ShotPair[] {
  const group = path.dirname(taskDir);
  // ownOnly: 指摘への対応の回のコメント用。その回のタスクの変更前 → 変更後だけ（feature の最初の変更前ではない）
  const isSingle = ownOnly || path.basename(group) === "single";
  const mine = path.basename(taskDir);
  const taskIds = isSingle
    ? [taskId]
    : readdirSync(group)
        .filter((n) => TASK_DIR.test(n) && n <= mine && existsSync(path.join(group, n, "current-task.md")))
        .sort()
        .map((n) => readTaskId(path.join(group, n)));
  const pairs = new Map<string, ShotPair>();
  for (const id of taskIds) {
    const labels = readLabels(root, id);
    for (const file of shotsOf(root, id)) {
      const m = path.basename(file).match(/^(before|after)-(.+)\.png$/i)!;
      const name = m[2];
      const pair = pairs.get(name) ?? { name, before: null, after: null, label: null };
      if (m[1].toLowerCase() === "before") pair.before ??= file;
      else pair.after = file;
      pair.label = labels.get(name) ?? pair.label; // 後のタスクのラベルを優先
      pairs.set(name, pair);
    }
  }
  return [...pairs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function readPrSource(root: string, taskDir: string, opts: { ownShotsOnly?: boolean } = {}): PrSource {
  const stamp = path.basename(taskDir).match(TASK_DIR)?.[1] ?? "";
  const taskId = readTaskId(taskDir);
  const result = readText(path.join(taskDir, "current-result.md"));
  const userTask = readText(path.join(taskDir, "user-task.md"));
  return {
    taskDir,
    stamp,
    taskId,
    requested: userTask === null ? null : parseRequested(userTask).filter((g) => !isProcessHeading(g.heading)),
    processHeadings: userTask === null ? [] : parseRequested(userTask).filter((g) => isProcessHeading(g.heading)).map((g) => g.heading),
    requestTitle: userTask === null ? null : requestTitleOf(userTask),
    shots: collectShots(root, taskDir, taskId, opts.ownShotsOnly === true),
    metadata: readMetadata(taskDir),
    declared: readDeclared(taskDir),
    acceptance: result === null ? null : countTriStatusAny(result, "## Acceptance Criteria Verification"),
    manualVerification: result === null ? null : sectionItems(result, "## Manual Verification Required"),
    review: readReview(root, taskDir),
    process: readProcess(root, stamp)
  };
}
