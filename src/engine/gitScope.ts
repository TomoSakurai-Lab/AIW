// diff-scope の git 側。検査対象リポジトリの特定、baseline の取得/保存、現在状態との比較。
// 設計は docs/design-diff-scope.md を正本とする。
//
// 最優先事項は halt できることではなく **偽陽性を出さないこと**。検査対象リポジトリには常時
// タスクと無関係な未コミット変更があり（実測32件）、HEAD と単純比較する実装は「常に違反を出す
// validator」になって無効化される。そのための baseline 方式。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rootPaths } from "./paths.js";
import type { WorkflowConfig } from "./types.js";

export class GitScopeError extends Error {}

// ---------------------------------------------------------------------------
// checkRepoRoot — runtimeRoot とは別概念
// ---------------------------------------------------------------------------
// runtimeRoot  = .ai-workflow2 の場所（resolveRoot / AIW_ROOT）
// checkRepoRoot = git コマンドを実行する検査対象リポジトリ
// 2つを混ぜないために名前を分けている。環境変数や CLI フラグは増やさない（設計課題1）。

export type RepoRootResolution =
  | { ok: true; repoRoot: string; source: "settings.repoRoot" | "auto" }
  | { ok: false; reason: string };

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    });
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    throw new GitScopeError(`git ${args.join(" ")} failed: ${(e.stderr || e.message || "").toString().trim()}`);
  }
}

export function resolveCheckRepoRoot(runtimeRoot: string, config: WorkflowConfig): RepoRootResolution {
  const declared = config.settings.repoRoot;
  if (typeof declared === "string" && declared.trim() !== "") {
    const abs = path.isAbsolute(declared) ? declared : path.resolve(runtimeRoot, declared);
    if (!existsSync(abs)) {
      return { ok: false, reason: `settings.repoRoot "${declared}" does not exist (resolved to ${abs})` };
    }
    try {
      return { ok: true, repoRoot: normalizeRoot(git(abs, ["rev-parse", "--show-toplevel"])), source: "settings.repoRoot" };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }
  // 既定: runtimeRoot の親から最も近い囲みリポジトリ。エンジン(tools/aiw)の場所は関与しない。
  const start = path.dirname(path.resolve(runtimeRoot));
  try {
    return { ok: true, repoRoot: normalizeRoot(git(start, ["rev-parse", "--show-toplevel"])), source: "auto" };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

function normalizeRoot(out: string): string {
  return out.trim().replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// 作業ツリーの現在状態
// ---------------------------------------------------------------------------

export type DirtyEntry = {
  /** checkRepoRoot 相対・"/" 区切り */
  path: string;
  /** porcelain の XY 2文字 */
  state: string;
  /** 作業ツリーのバイト列の sha256。削除済みは null */
  sha256: string | null;
  /** rename / copy の元パス */
  origPath?: string;
};

export type RepoState = {
  /** 初回コミット前は null。HEAD 移動の検知は参考情報なので null でも判定は劣化しない */
  headSha: string | null;
  ignoreCase: boolean;
  dirty: DirtyEntry[];
};

// `--porcelain -z` を使う理由: 既定の porcelain は空白入りパスを `"with space.txt"` と
// C形式で引用するため復号が要る。-z は引用せず NUL 区切りで、rename も
// `R  <新パス>NUL<旧パス>NUL` と構造的に分離される（非-z の `旧 -> 新` とは順序が逆）。
export function parsePorcelainZ(raw: string): DirtyEntry[] {
  const parts = raw.split("\0");
  const out: DirtyEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) {
      continue;
    }
    const state = entry.slice(0, 2);
    const p = entry.slice(3).replace(/\\/g, "/");
    let origPath: string | undefined;
    if (state[0] === "R" || state[0] === "C") {
      origPath = (parts[++i] ?? "").replace(/\\/g, "/");
    }
    out.push({ path: p, state, sha256: null, ...(origPath ? { origPath } : {}) });
  }
  return out;
}

function hashWorkingFile(repoRoot: string, rel: string): string | null {
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) {
    return null; // 削除済み
  }
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null; // ディレクトリ等、読めないものは内容比較の対象外
  }
}

export function readRepoState(repoRoot: string): RepoState {
  let headSha: string | null = null;
  try {
    headSha = git(repoRoot, ["rev-parse", "--verify", "HEAD"]).trim();
  } catch {
    headSha = null; // 空リポジトリ（初回コミット前）
  }

  let ignoreCase = false; // 未設定は安全側（大小文字を区別する＝偽陽性側）
  try {
    ignoreCase = git(repoRoot, ["config", "--get", "core.ignorecase"]).trim() === "true";
  } catch {
    ignoreCase = false;
  }

  const dirty = parsePorcelainZ(git(repoRoot, ["status", "--porcelain", "-uall", "-z"])).map((e) => ({
    ...e,
    sha256: hashWorkingFile(repoRoot, e.path)
  }));

  return { headSha, ignoreCase, dirty };
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

export type CapturedFor = { step: string; fixAttempts: number };

export type Baseline = {
  version: 1;
  capturedFor: CapturedFor;
  capturedAt: string;
  checkRepoRoot: string;
  headSha: string | null;
  ignoreCase: boolean;
  dirty: DirtyEntry[];
};

export function baselinePath(runtimeRoot: string): string {
  return path.join(rootPaths(runtimeRoot).runsDir, "baseline.json");
}

export function readBaseline(runtimeRoot: string): Baseline | null {
  const file = baselinePath(runtimeRoot);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Baseline;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null; // 壊れた baseline は「無い」と同じ扱い（欠損として課題4の分岐に乗る）
  }
}

export function deleteBaseline(runtimeRoot: string): void {
  rmSync(baselinePath(runtimeRoot), { force: true });
}

function writeBaseline(runtimeRoot: string, baseline: Baseline): void {
  const file = baselinePath(runtimeRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

export type CaptureOutcome =
  | { kind: "captured"; baseline: Baseline }
  | { kind: "already-current"; baseline: Baseline }
  | { kind: "failed"; reason: string };

export function sameCapturedFor(a: CapturedFor, b: CapturedFor): boolean {
  return a.step === b.step && a.fixAttempts === b.fixAttempts;
}

function capture(runtimeRoot: string, config: WorkflowConfig, capturedFor: CapturedFor): CaptureOutcome {
  const resolved = resolveCheckRepoRoot(runtimeRoot, config);
  if (!resolved.ok) {
    return { kind: "failed", reason: resolved.reason };
  }
  let state: RepoState;
  try {
    state = readRepoState(resolved.repoRoot);
  } catch (error) {
    return { kind: "failed", reason: (error as Error).message };
  }
  const baseline: Baseline = {
    version: 1,
    capturedFor,
    capturedAt: new Date().toISOString(),
    checkRepoRoot: resolved.repoRoot,
    headSha: state.headSha,
    ignoreCase: state.ignoreCase,
    dirty: state.dirty
  };
  writeBaseline(runtimeRoot, baseline);
  return { kind: "captured", baseline };
}

// エンジン専用の入口。**force 引数を持たない。**
//
// resume のたびに baseline を取り直すと、Codex が既に行った変更が baseline へ吸収され、
// diff-scope は必ず「違反なし」を返すようになる。しかもエラーは出ない（KI-04 と同じバグクラス）。
// 強制取得の手段をこの関数に持たせないことで、エンジン経路から罠を踏めなくしている。
export function captureIfAbsent(runtimeRoot: string, config: WorkflowConfig, capturedFor: CapturedFor): CaptureOutcome {
  const existing = readBaseline(runtimeRoot);
  if (existing && sameCapturedFor(existing.capturedFor, capturedFor)) {
    return { kind: "already-current", baseline: existing };
  }
  return capture(runtimeRoot, config, capturedFor);
}

/**
 * `aiw baseline capture` 専用。無条件に取り直す。
 *
 * **製品コードでこの関数を import してよいのは src/cli.ts のみ**（テストは検証のため可）。
 * engine/ 配下から呼ぶと、captureIfAbsent で型ごと塞いだ「resume での再取得」が別経路で
 * 復活する。この制約は test/gitscope.test.ts の Test 58 が機械的に検査している。
 * 検査を骨抜きにできる操作なので、対話確認を経た人間の明示操作からのみ到達すること
 * （確認を省くオプションは追加しない。M5 の aiw auto から呼べないようにするため）。
 */
export function recaptureBaseline(
  runtimeRoot: string,
  config: WorkflowConfig,
  capturedFor: CapturedFor
): CaptureOutcome {
  return capture(runtimeRoot, config, capturedFor);
}

// ---------------------------------------------------------------------------
// 比較
// ---------------------------------------------------------------------------

export type ChangedFile = {
  path: string;
  /** new-dirty = baseline に無い / modified-since = baseline にあり内容が変わった(シナリオ7) */
  kind: "new-dirty" | "modified-since";
  state: string;
};

export type ScopeComparison = {
  changed: ChangedFile[];
  /** シナリオ6: タスク中のコミット。違反にはせず参考情報として出す */
  headMoved: { baselineSha: string | null; currentSha: string | null } | null;
  /** 実際に使った比較方式。baseline と現在で食い違う場合は安全側(false)へ倒す */
  ignoreCase: boolean;
};

function key(p: string, ignoreCase: boolean): string {
  return ignoreCase ? p.toLowerCase() : p;
}

export function compareToBaseline(baseline: Baseline, current: RepoState): ScopeComparison {
  // baseline と現在で core.ignorecase が食い違う場合（設定変更・別環境で取得）は
  // case-sensitive(false) を採る。同一視をやめる方向＝見逃しではなく過検出に倒れる。
  const ignoreCase = baseline.ignoreCase && current.ignoreCase;

  const before = new Map<string, DirtyEntry>();
  for (const e of baseline.dirty) {
    before.set(key(e.path, ignoreCase), e);
  }

  const changed: ChangedFile[] = [];
  const seen = new Set<string>();
  const push = (p: string, kind: ChangedFile["kind"], state: string): void => {
    const k = key(p, ignoreCase);
    if (seen.has(k)) {
      return;
    }
    seen.add(k);
    changed.push({ path: p, kind, state });
  };

  for (const e of current.dirty) {
    const prev = before.get(key(e.path, ignoreCase));
    if (!prev) {
      push(e.path, "new-dirty", e.state);
    } else if (prev.sha256 !== e.sha256) {
      // baseline 時点で既に dirty だったファイルが更に変わった。誰の変更かは原理的に不明。
      push(e.path, "modified-since", e.state);
    }
    // rename/copy の元パスも変更として扱う。宣言外のファイルを宣言済みの名前へ
    // 改名して検査をすり抜ける経路を塞ぐ。
    if (e.origPath && !before.has(key(e.origPath, ignoreCase))) {
      push(e.origPath, "new-dirty", e.state);
    }
  }

  // baseline にあって現在 dirty でないファイルは「元に戻された or コミットされた」であり
  // 違反ではない（後者は headMoved で補足する）。

  const headMoved =
    baseline.headSha !== current.headSha
      ? { baselineSha: baseline.headSha, currentSha: current.headSha }
      : null;

  return { changed, headMoved, ignoreCase };
}
