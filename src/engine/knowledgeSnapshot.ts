// その場で書き換えるファイルのスナップショットと差分サマリ（小枠A・2026-10-19・設計 docs/design-reflection.md）。
//
// reflection は知識ファイル（context.md / learnings.md / backlog.md / research/）をその場で書き換える。自動化の失敗は以後の全タスクの入力を
// 静かに汚染するので、人間が差分を見て承認できるようにし、却下したらスナップショットへ戻してから再実行する（不変条件2・3）。
//
// ⚠️ **対象はエンジンが宣言から導く**: そのステップの inputs と outputs（+ optionalOutputs）の両方に載っているもの＝その場で書き換えるファイル。
// 知識ファイルの名前をここに書かない（宣言が正本・不変条件7）。今の宣言では reflection の知識ファイルと、task-planning の feature.md が当たる。
// ⚠️ バックアップリポ（.ai-workflow/.git）には頼らない（環境固有で、aiw init の環境には無い）。比較は git diff --no-index（diff-scope と同じく git は前提）。
// ⚠️ 退避であって削除ではない: 却下で戻す前の状態は runs/snapshots/<step>-rejected-<時刻>/ へ移し、タスクの archive へ随伴させる。

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendEvent } from "./eventLog.js";
import { rootPaths } from "./paths.js";
import type { WorkflowStep } from "./types.js";

/** 差分の本文を報告へ載せる上限（行）。超えた分は runs/ の全文を見る */
export const DIFF_BODY_LINE_LIMIT = 300;
/** 異常候補: 1 ファイルでこれ以上の削除は「既存の大幅削除」 */
export const LARGE_DELETION_LINES = 30;
/** 異常候補: 1 ファイルでこれ以上の追加は「大量追加」 */
export const LARGE_ADDITION_LINES = 80;

type Target = { path: string; dir: boolean; existed: boolean };
type Manifest = { step: string; capturedAt: string; targets: Target[] };

export type KnowledgeDiffSummary = {
  step: string;
  /** 停止の1行や run の表示に出す要約 */
  line: string;
  /** 報告ファイル（root 相対） */
  report: string;
  anomalies: string[];
  files: Array<{ path: string; added: number; removed: number }>;
  bl: { added: string[]; changed: string[]; removed: string[] };
};

/** inputs ∩（outputs ∪ optionalOutputs）。宣言から導く */
export function inPlaceTargets(step: WorkflowStep): string[] {
  const inputs = new Set((step.inputs ?? []).map((f) => f.path));
  return [...(step.outputs ?? []), ...(step.optionalOutputs ?? [])].map((f) => f.path).filter((p) => inputs.has(p));
}

function snapshotDir(root: string, stepId: string): string {
  return path.join(rootPaths(root).runsDir, "snapshots", stepId);
}

function readManifest(root: string, stepId: string): Manifest | null {
  const file = path.join(snapshotDir(root, stepId), "manifest.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** ステップへ入るときに撮る（遷移で入るとき・new-task）。前のスナップショットは撮り直す。executor に依存しない（clipboard でも撮る） */
export function captureSnapshot(root: string, step: WorkflowStep, logBase: Record<string, unknown>): void {
  const targets = inPlaceTargets(step);
  if (targets.length === 0) return;
  const dir = snapshotDir(root, step.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "files"), { recursive: true });
  const recorded: Target[] = [];
  for (const rel of targets) {
    const src = path.join(path.resolve(root), rel);
    const isDir = rel.endsWith("/");
    const existed = existsSync(src);
    if (existed) {
      cpSync(src, path.join(dir, "files", rel), { recursive: true });
    }
    recorded.push({ path: rel, dir: isDir, existed });
  }
  const manifest: Manifest = { step: step.id, capturedAt: new Date().toISOString(), targets: recorded };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  appendEvent(root, "snapshot.captured", { ...logBase, step: step.id, files: recorded.map((t) => `${t.path}${t.existed ? "" : "（無し）"}`) });
}

/** git diff --no-index（差分があると exit 1）。片側が無いときは空の置き場と比べる */
function gitDiff(args: string[], before: string, after: string): string {
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", ...args, "--", before, after], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout ?? "";
}

type BlEntry = { status: string; summary: string };
function parseBacklog(text: string): { entries: Map<string, BlEntry>; duplicates: string[] } {
  const entries = new Map<string, BlEntry>();
  const duplicates: string[] = [];
  const blocks = text.split(/^(?=## BL-\d+)/m);
  for (const block of blocks) {
    const m = block.match(/^## (BL-\d+)/);
    if (!m) continue;
    const status = (block.match(/^- Status:\s*(.*)$/m)?.[1] ?? "").trim();
    const summary = (block.match(/^- Summary:\s*(.*)$/m)?.[1] ?? "").trim();
    if (entries.has(m[1])) duplicates.push(m[1]);
    entries.set(m[1], { status, summary });
  }
  return { entries, duplicates };
}

function readIfFile(p: string): string {
  return existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8") : "";
}

/**
 * スナップショットと今を比べて `runs/snapshots/<step>/knowledge-diff.md` を書き、Event Log に `knowledge.diff` を残す。
 * スナップショットが無ければ null（このステップは対象外）。**異常候補を先頭に並べる**（読む価値の密度を機械側が作る・素通し承認の脱感作を防ぐ）
 */
export function writeKnowledgeDiff(root: string, stepId: string, logBase: Record<string, unknown>): KnowledgeDiffSummary | null {
  const manifest = readManifest(root, stepId);
  if (!manifest) return null;
  const dir = snapshotDir(root, stepId);
  const empty = path.join(dir, "_empty");
  mkdirSync(path.join(empty, "dir"), { recursive: true });
  writeFileSync(path.join(empty, "file"), "", "utf8");

  const files: KnowledgeDiffSummary["files"] = [];
  const bodies: string[] = [];
  const anomalies: string[] = [];
  const bl = { added: [] as string[], changed: [] as string[], removed: [] as string[] };

  for (const t of manifest.targets) {
    const before = t.existed ? path.join(dir, "files", t.path) : path.join(empty, t.dir ? "dir" : "file");
    const nowPath = path.join(path.resolve(root), t.path);
    const after = existsSync(nowPath) ? nowPath : path.join(empty, t.dir ? "dir" : "file");
    for (const line of gitDiff(["--numstat"], before, after).split(/\r?\n/).filter(Boolean)) {
      const [a, r] = line.split("\t");
      const added = Number(a) || 0;
      const removed = Number(r) || 0;
      // 2026-10-20: git は \ を含むパスを "…" で囲み、--no-index の改名は {a => b} で出す。ファイル名だけを取り出す（以前は末尾に " が残った）
      const raw = (line.split("\t")[2] ?? "").replace(/^"|"$/g, "");
      const name = (raw.includes(" => ") ? raw.split(" => ").pop()! : raw).replace(/[{}"]/g, "").split(/[\\/]+/).pop() ?? "";
      const label = t.dir ? `${t.path}${name}` : t.path;
      files.push({ path: label, added, removed });
      if (removed >= LARGE_DELETION_LINES) anomalies.push(`${label}: 既存の大幅削除（-${removed} 行）`);
      if (added >= LARGE_ADDITION_LINES) anomalies.push(`${label}: 大量追加（+${added} 行）`);
    }
    bodies.push(gitDiff(["--unified=2"], before, after));

    // `## BL-` の見出しを持つファイル（backlog の書式）は、追加・状態の変化・削除・重複を ID で拾う
    if (!t.dir) {
      const beforeText = readIfFile(before);
      const afterText = readIfFile(after);
      if (/^## BL-\d+/m.test(beforeText + afterText)) {
        const b = parseBacklog(beforeText);
        const a = parseBacklog(afterText);
        for (const [id, e] of a.entries) {
          if (!b.entries.has(id)) bl.added.push(id);
          else if (b.entries.get(id)!.status !== e.status) bl.changed.push(`${id}（${b.entries.get(id)!.status || "?"} → ${e.status || "?"}）`);
        }
        for (const id of b.entries.keys()) if (!a.entries.has(id)) bl.removed.push(id);
        for (const id of a.duplicates) anomalies.push(`${t.path}: ${id} が二重にある（重複疑い）`);
        for (const id of bl.added) {
          const s = a.entries.get(id)!.summary;
          const twin = [...b.entries].find(([, e]) => s !== "" && e.summary === s);
          if (twin) anomalies.push(`${t.path}: 追加の ${id} の Summary が既存の ${twin[0]} と同じ（重複疑い）`);
        }
        for (const id of bl.removed) anomalies.push(`${t.path}: 既存の ${id} が消えた`);
      }
    }
  }

  const diffLines = bodies.join("").split(/\r?\n/);
  const shown = diffLines.slice(0, DIFF_BODY_LINE_LIMIT);
  const rest = Math.max(0, diffLines.length - shown.length);
  const changed = files.filter((f) => f.added + f.removed > 0);
  const line =
    (anomalies.length > 0 ? `⚠️ 異常候補 ${anomalies.length} 件 / ` : "異常候補なし / ") +
    (changed.length > 0 ? changed.map((f) => `${f.path} +${f.added}/-${f.removed}`).join(" / ") : "差分なし") +
    (bl.added.length > 0 ? ` / BL 追加 ${bl.added.join(", ")}` : "") +
    (bl.changed.length > 0 ? ` / BL 状態変更 ${bl.changed.length} 件` : "");

  const reportRel = path.relative(path.resolve(root), path.join(dir, "knowledge-diff.md")).replace(/\\/g, "/");
  const md = [
    `# Knowledge Diff — ${stepId}`,
    "",
    `スナップショット: ${manifest.capturedAt}（このステップへ入った時点）と、今の差分。承認の前に見る。`,
    "",
    "## 異常候補",
    "",
    ...(anomalies.length > 0 ? anomalies.map((a) => `- ${a}`) : ["- 異常候補なし"]),
    "",
    "## ファイルごとの増減",
    "",
    "| ファイル | 追加 | 削除 |",
    "| --- | ---: | ---: |",
    ...(files.length > 0 ? files.map((f) => `| ${f.path} | ${f.added} | ${f.removed} |`) : ["| （差分なし） | 0 | 0 |"]),
    "",
    "## backlog の変化",
    "",
    `- 追加: ${bl.added.join(", ") || "なし"}`,
    `- 状態の変化: ${bl.changed.join(", ") || "なし"}`,
    `- 削除: ${bl.removed.join(", ") || "なし"}`,
    "",
    `## 差分（先頭 ${DIFF_BODY_LINE_LIMIT} 行）`,
    "",
    "```diff",
    ...shown,
    "```",
    ...(rest > 0 ? ["", `（残り ${rest} 行は省略。全文: git diff --no-index ${path.relative(path.resolve(root), path.join(dir, "files")).replace(/\\/g, "/")} <今のファイル>）`] : []),
    ""
  ].join("\n");
  writeFileSync(path.join(dir, "knowledge-diff.md"), md, "utf8");
  const summary: KnowledgeDiffSummary = { step: stepId, line, report: reportRel, anomalies, files: changed, bl };
  // 承認待ちの表示（auto の A1 / drive のゲート）は state から導くので、要約もファイルで持つ
  writeFileSync(path.join(dir, "knowledge-diff.json"), JSON.stringify(summary, null, 2), "utf8");
  appendEvent(root, "knowledge.diff", { ...logBase, step: stepId, files: changed, bl, anomalies, report: reportRel });
  return summary;
}

/** 承認待ちの表示用: 直近の差分サマリ（無ければ null） */
export function readKnowledgeDiff(root: string, stepId: string): KnowledgeDiffSummary | null {
  const file = path.join(snapshotDir(root, stepId), "knowledge-diff.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as KnowledgeDiffSummary;
  } catch {
    return null;
  }
}

/**
 * 却下（rerun）で、今の状態を runs/snapshots/<step>-rejected-<時刻>/ へ**退避**してから、スナップショットへ戻す。
 * 戻さずに再実行すると、前回の追記の上にもう一度追記して重複する（不変条件2・3）。スナップショットが無ければ null
 */
export function restoreSnapshot(root: string, stepId: string, logBase: Record<string, unknown>): string | null {
  const manifest = readManifest(root, stepId);
  if (!manifest) return null;
  const dir = snapshotDir(root, stepId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const saved = path.join(rootPaths(root).runsDir, "snapshots", `${stepId}-rejected-${stamp}`);
  mkdirSync(saved, { recursive: true });
  for (const t of manifest.targets) {
    const now = path.join(path.resolve(root), t.path);
    if (existsSync(now)) {
      mkdirSync(path.dirname(path.join(saved, t.path)), { recursive: true });
      renameSync(now, path.join(saved, t.path)); // 退避（削除ではない）
    }
    if (t.existed) {
      cpSync(path.join(dir, "files", t.path), now, { recursive: true });
    }
  }
  const savedRel = path.relative(path.resolve(root), saved).replace(/\\/g, "/");
  appendEvent(root, "knowledge.restored", { ...logBase, step: stepId, savedTo: savedRel, files: manifest.targets.map((t) => t.path) });
  return savedRel;
}

/** タスクの archive へ、差分の報告（knowledge-diff-<step>.md）と却下で退避した状態を移す。runs/snapshots/ はその後で消す（discardSnapshots） */
export function archiveSnapshots(root: string, dest: string): void {
  const base = path.join(rootPaths(root).runsDir, "snapshots");
  if (!existsSync(base)) return;
  for (const name of readdirSync(base)) {
    const p = path.join(base, name);
    if (/-rejected-/.test(name)) {
      cpSync(p, path.join(dest, `knowledge-${name}`), { recursive: true });
    } else if (existsSync(path.join(p, "knowledge-diff.md"))) {
      cpSync(path.join(p, "knowledge-diff.md"), path.join(dest, `knowledge-diff-${name}.md`));
    }
  }
}

export function discardSnapshots(root: string): void {
  rmSync(path.join(rootPaths(root).runsDir, "snapshots"), { recursive: true, force: true });
}
