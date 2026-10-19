// 起動前チェック（preflight・BL-286・2026-10-19）。`steps.<id>.preflight` に書いたコマンドを、aiw auto が exec の直前に実行する。
//
// 実測（10-15 / 10-16）: implementation の codex が「IIS Express を停止して『停止済み』と知らせてください」と人に頼んでターンを終え、
// status を書かずに終わった。auto はこれを A17（無進行・exit 5）として止め、「executor が status を書かなかった」と表示した——
// 実際の意味は「人の作業が要る」で、エラーではない。exec の前に人の作業が要るかを確かめ、要るなら**人の番**として止める。
//
// ⚠️ エンジンが知っているのは「コマンドを実行し、0 以外なら message を表示して止まる」だけ。IIS Express のような
// 環境固有の名前は runtime の workflow.yaml の値にだけ現れる（不変条件7・local-environment と同じ分離）。
// ⚠️ コマンドは argv の配列で受け取り、シェルを通さない（KI-08: シェル経由は特殊文字を含む argv を壊す）。

import { spawnSync } from "node:child_process";

export type PreflightCheck = {
  /** 実行するコマンド（argv）。exit 0 = 進んでよい */
  command: string[];
  /** 0 以外のときの扱い。今は pause（auto が人の番として止まる）だけ */
  onFail: "pause";
  /** 止まったときに表示する1行（人がすること） */
  message: string;
  /** 上限（ミリ秒）。既定 30 秒 */
  timeoutMs?: number;
};

export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000;

/** ローダー用。書き損じは黙って捨てずにロード時に落とす（auto: "yes" と同じ方針） */
export function resolvePreflight(id: string, value: unknown): PreflightCheck[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Step "${id}" declares preflight that is not a list.`);
  }
  return value.map((raw, i) => {
    const where = `Step "${id}" preflight[${i}]`;
    if (!raw || typeof raw !== "object") {
      throw new Error(`${where} is not a mapping.`);
    }
    const r = raw as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!["command", "onFail", "message", "timeoutMs"].includes(key)) {
        throw new Error(`${where} has an unknown key "${key}". Allowed: command, onFail, message, timeoutMs.`);
      }
    }
    if (!Array.isArray(r.command) || r.command.length === 0 || r.command.some((a) => typeof a !== "string" || a === "")) {
      throw new Error(`${where}.command must be a non-empty list of strings (argv; no shell).`);
    }
    if (r.onFail !== "pause") {
      throw new Error(`${where}.onFail must be "pause" (got ${JSON.stringify(r.onFail)}).`);
    }
    if (typeof r.message !== "string" || r.message.trim() === "") {
      throw new Error(`${where}.message must be a non-empty string.`);
    }
    if (r.timeoutMs !== undefined && (typeof r.timeoutMs !== "number" || !Number.isInteger(r.timeoutMs) || r.timeoutMs <= 0)) {
      throw new Error(`${where}.timeoutMs must be a positive integer.`);
    }
    return {
      command: r.command as string[],
      onFail: "pause",
      message: r.message.trim(),
      ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs as number } : {})
    };
  });
}

export type PreflightOutcome =
  | { ok: true; checked: number }
  | { ok: false; check: PreflightCheck; exitCode: number | null; reason: string };

/** 先頭から順に実行し、最初に通らなかったものを返す。実行できない・時間切れも「通らなかった」（人に見てもらう側へ倒す） */
export function runPreflight(cwd: string, checks: PreflightCheck[]): PreflightOutcome {
  for (const check of checks) {
    const [exe, ...args] = check.command;
    const timeoutMs = check.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
    const started = Date.now();
    const proc = spawnSync(exe, args, { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true, shell: false });
    const err = proc.error as NodeJS.ErrnoException | undefined;
    if (err?.code === "ETIMEDOUT" || Date.now() - started >= timeoutMs) {
      return { ok: false, check, exitCode: null, reason: `確認コマンドが ${Math.round(timeoutMs / 1000)}s で終わらなかった` };
    }
    if (err) {
      return { ok: false, check, exitCode: null, reason: `確認コマンドを実行できなかった（${err.code ?? err.message}）` };
    }
    if (proc.status !== 0) {
      return { ok: false, check, exitCode: proc.status, reason: `確認コマンドが exit ${proc.status}` };
    }
  }
  return { ok: true, checked: checks.length };
}
