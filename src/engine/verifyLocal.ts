// verify-local — ローカルで決定論的に実行できる検証（M1.5 第3部）。v1 は typecheck 1本。
//
// diff-scope と同じ轍を踏まないための設計:
//
//   `tsc --noEmit` は対象ファイル0件でも exit 0 を返す。cwd を間違えても tsconfig が壊れても
//   「成功」に見える。だから **何件見たかを毎回メッセージに出す**（0件なら skipped）。
//   検査範囲を常時明示するのは diff-scope の `checked <repoRoot>` と同じ論理。
//
// onViolation は report。無人運転で flaky 1本のたびに止まると運用が成立しないため、
// 失敗は test-report.md として review へ渡し、既存の fix ループ（fixAttempts で有界）に乗せる。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type VerifyLocalCommand = {
  /** checkRepoRoot からの相対。省略時は checkRepoRoot 直下 */
  cwd?: string;
  /** argv 配列。シェルを経由しない */
  command: string[];
  /** 検査したファイル数を数えるとき、この語を含む行は除外する */
  countFilesExcluding?: string[];
  timeoutMs?: number;
  /** このコマンドが**見ていない**範囲。メッセージへ必ず出す */
  notChecked?: string;
};

export type VerifyLocalOutcome =
  | { kind: "passed"; fileCount: number | null; durationMs: number; output: string }
  | { kind: "failed"; fileCount: number | null; durationMs: number; output: string; exitCode: number | null }
  // 「検査できなかった」。**failed（違反あり）と区別する。** タイムアウトもここ——
  // タイムアウトは「型エラーがあった」ではなく「検査が完了しなかった」なので、
  // failed にすると意味的に偽ることになる（設計課題4で採ったのと同じ論理）。
  | { kind: "skipped"; reason: string; fileCount?: number | null; durationMs?: number };

const ERROR_LINE = /\)\s*:\s*error\s/i;

// `--listFiles` の出力から、実際に走査されたソースファイル数を数える。
// tsc はエラー時もファイル一覧を出すので、1回の実行で結果とカバレッジの両方が取れる。
export function countCheckedFiles(output: string, excluding: string[] = ["node_modules"]): number {
  return output.split(/\r?\n/).filter((line) => {
    const l = line.trim();
    if (l === "" || ERROR_LINE.test(l)) {
      return false;
    }
    // 絶対パスに見える行だけを数える（Windows の `C:/...` と POSIX の `/...` 両方）
    if (!/^([A-Za-z]:[\\/]|\/)/.test(l)) {
      return false;
    }
    return !excluding.some((ex) => l.includes(ex));
  }).length;
}

export function runVerifyLocal(checkRepoRoot: string, spec: VerifyLocalCommand): VerifyLocalOutcome {
  if (!Array.isArray(spec.command) || spec.command.length === 0) {
    return { kind: "skipped", reason: "no command configured" };
  }
  const cwd = spec.cwd ? path.resolve(checkRepoRoot, spec.cwd) : path.resolve(checkRepoRoot);
  if (!existsSync(cwd)) {
    return { kind: "skipped", reason: `cwd does not exist: ${cwd}` };
  }

  const [exe, ...args] = spec.command;
  const timeoutMs = spec.timeoutMs ?? 120000;
  const started = Date.now();
  const proc = spawnSync(exe, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: process.platform === "win32", // npx 等は Windows では .cmd なので shell が要る
    maxBuffer: 64 * 1024 * 1024
  });
  const durationMs = Date.now() - started;
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;

  // タイムアウト判定に経過時間を含める理由（Windows 実測）:
  //   shell: false → status: null / signal: "SIGTERM" / error.code: "ETIMEDOUT"
  //   shell: true  → status: 1    / signal: null      / error: undefined  ← 本物の失敗と同じ形
  // shell 経由では kill されたシェルが exit 1 を返すだけで、タイムアウトの痕跡が残らない。
  // 経過時間を見ないと「検査が完了しなかった」を「検査して失敗した」と誤認する。
  const timedOut =
    (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    proc.signal !== null ||
    durationMs >= timeoutMs;
  if (timedOut) {
    return { kind: "skipped", reason: `timed out after ${timeoutMs}ms`, durationMs };
  }
  if (proc.error) {
    return { kind: "skipped", reason: `could not run ${exe}: ${proc.error.message}`, durationMs };
  }

  const fileCount = countCheckedFiles(output, spec.countFilesExcluding);

  // 0件は「検査した結果 OK」ではない。cwd 誤り・tsconfig 破壊・include 漏れのいずれかで、
  // exit 0 が返ってくるので passed と区別しないと気づけない。
  if (fileCount === 0) {
    return {
      kind: "skipped",
      reason: "0 source files were checked — verify cwd / tsconfig",
      fileCount,
      durationMs
    };
  }

  return proc.status === 0
    ? { kind: "passed", fileCount, durationMs, output }
    : { kind: "failed", fileCount, durationMs, output, exitCode: proc.status };
}

/** 検査範囲を常時出すための接尾辞。「見ていない範囲」も必ず書く。 */
export function scopeNote(spec: VerifyLocalCommand, fileCount: number | null, durationMs?: number): string {
  const where = spec.cwd ?? ".";
  const files = fileCount === null ? "?" : String(fileCount);
  const secs = durationMs === undefined ? "" : ` (${(durationMs / 1000).toFixed(1)}s)`;
  const not = spec.notChecked ? `; ${spec.notChecked} not checked` : "";
  return `${files} source files in ${where}${secs}${not}`;
}
