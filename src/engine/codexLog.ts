// `aiw log` の読み取り側（M3・課題I）。
//
// **読むだけ。新しい記録は作らない。** 情報源は codex executor が保存した
// `runs/codex/<時刻>-<step>.jsonl` だけで、Event Log も state も触らない。
//
// なぜ要るか: 実測で 1 実行 441 KB / 119 イベント / 401K 文字。単一イベントが 51,684 文字ある。
// **生のままでは読めない**ので、種別と対象だけの時系列へ畳む。
//
// ⚠️ イベントに**タイムスタンプは無い**（実測: トップレベルのキーは type / item / thread_id / usage）。
// 時刻を出せるのは実行開始時刻だけで、それはファイル名から取る。順序は JSONL の並び。
//
// ⚠️ **生 session ID を出さない**（不変条件6）。thread_id は SessionRef へ畳んでから返す。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { rootPaths } from "./paths.js";
import { redactSession, sessionSecret, toSessionRef, type SessionRef, type SessionSecret } from "./session.js";

export type LogEntryKind = "say" | "edit" | "shell" | "think" | "error" | "other";

export type LogEntry = {
  /** JSONL 内の並び順（1 始まり）。タイムスタンプが無いのでこれが唯一の時間軸 */
  seq: number;
  kind: LogEntryKind;
  /** 1 行の要約 */
  text: string;
  /** shell の終了コード。それ以外では undefined */
  exitCode?: number | null;
  /** edit で触れたファイル（basename） */
  files?: string[];
};

export type LogUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};

export type RunLog = {
  /** root からの相対パス */
  file: string;
  /** 実行開始時刻（ファイル名由来。ISO 文字列） */
  startedAt: string | null;
  step: string;
  entries: LogEntry[];
  usage: LogUsage | null;
  /** hash + 末尾のみ。**生 ID は持たない** */
  session: SessionRef | null;
  /** 種別ごとの件数（要約表示用） */
  counts: Record<LogEntryKind, number>;
};

/** `runs/codex/` から、そのステップの**直近の**実行ファイルを選ぶ。 */
export function findRunFile(root: string, step: string): string | null {
  const dir = path.join(rootPaths(root).runsDir, "codex");
  if (!existsSync(dir)) {
    return null;
  }
  const suffix = `-${step}.jsonl`;
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort(); // ファイル名の先頭が ISO 時刻なので辞書順 = 時刻順
  const last = hits[hits.length - 1];
  return last ? path.join(dir, last) : null;
}

/** ファイル名 `2026-08-21T02-20-36-853Z-implementation.jsonl` から開始時刻を復元する。 */
export function startedAtFromName(file: string): string | null {
  const m = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

function flatten(value: unknown, n: number): string {
  const s = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function basename(p: unknown): string {
  return String(p ?? "")
    .split(/[/\\]/)
    .pop() as string;
}

/**
 * シェルコマンドから**実際に走った中身**を取り出す。
 *
 * codex が渡すのは `"C:\WINDOWS\...\powershell.exe" -Command '<本体>'` の形で、
 * 素朴に先頭から切ると**インタプリタのパスだけで文字数を使い切って本体が見えない**
 * （試作でこの不備を踏んだ）。`-Command` / `-c` 以降を本体として扱う。
 */
export function shellBody(command: unknown): string {
  const raw = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  const m = raw.match(/\s-(?:Command|c)\s+([\s\S]+)$/i);
  const body = (m ? m[1] : raw).trim();
  // 外側の引用符を1組だけ剥がす（中身の引用符は残す）
  const unquoted = body.replace(/^(['"])([\s\S]*)\1$/, "$2");
  return flatten(unquoted, 100);
}

function classify(event: any, secret: SessionSecret | null): LogEntry | null {
  const type = event?.type;
  const item = event?.item ?? {};
  if (type === "error") {
    // ⚠️ codex の error 本文には thread_id が混ざることがある（実測）。
    // executor の表示経路と同じく、**出す直前で伏せる**。
    return { seq: 0, kind: "error", text: flatten(redactSession(String(event.message ?? ""), secret), 140) };
  }
  if (type === "item.started" && item.type === "reasoning") {
    return { seq: 0, kind: "think", text: "thinking..." };
  }
  if (type !== "item.completed") {
    return null;
  }
  switch (item.type) {
    case "agent_message":
      return { seq: 0, kind: "say", text: flatten(redactSession(String(item.text ?? ""), secret), 240) };
    case "file_change": {
      const files = (item.changes ?? []).map((c: any) => basename(c?.path)).filter(Boolean);
      return { seq: 0, kind: "edit", text: files.join(", ") || "(no path)", files };
    }
    case "command_execution":
      return {
        seq: 0,
        kind: "shell",
        text: shellBody(item.command),
        exitCode: typeof item.exit_code === "number" ? item.exit_code : null
      };
    case "reasoning":
      return null; // 開始側で出しているので二重に出さない
    default:
      return { seq: 0, kind: "other", text: flatten(item.type, 60) };
  }
}

/** JSONL を読んで構造化する。**壊れた行は落として読み進める**（一次資料なので途中で止めない）。 */
export function readRunLog(root: string, file: string): RunLog {
  const abs = path.resolve(file);
  const step = path.basename(abs).replace(/\.jsonl$/, "").replace(/^.*Z-/, "");
  const entries: LogEntry[] = [];
  const counts: Record<LogEntryKind, number> = { say: 0, edit: 0, shell: 0, think: 0, error: 0, other: 0 };
  let usage: LogUsage | null = null;
  let session: SessionRef | null = null;
  // ⚠️ 伏せるために生の値を**この関数の中だけ**で持つ。返り値には決して載せない。
  let secret: SessionSecret | null = null;

  for (const line of readFileSync(abs, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 壊れた行は飛ばす
    }
    if (event?.type === "thread.started" && typeof event.thread_id === "string") {
      secret = sessionSecret(event.thread_id);
      session = toSessionRef(secret); // 返すのは hash と末尾だけ
      continue;
    }
    if (event?.type === "turn.completed" && event.usage) {
      const n = (v: unknown) => (typeof v === "number" ? v : null);
      usage = {
        inputTokens: n(event.usage.input_tokens),
        cachedInputTokens: n(event.usage.cached_input_tokens),
        outputTokens: n(event.usage.output_tokens)
      };
      continue;
    }
    const entry = classify(event, secret);
    if (entry) {
      entry.seq = entries.length + 1;
      entries.push(entry);
      counts[entry.kind] += 1;
    }
  }

  return {
    file: path.relative(rootPaths(root).root, abs).replace(/\\/g, "/"),
    startedAt: startedAtFromName(abs),
    step,
    entries,
    usage,
    session,
    counts
  };
}

const MARK: Record<LogEntryKind, string> = {
  say: "say  ",
  edit: "edit ",
  shell: "shell",
  think: "think",
  error: "ERROR",
  other: "     "
};

/** 人間可読の整形。CLI はこれを出すだけ。 */
export function formatRunLog(log: RunLog): string {
  const out: string[] = [];
  out.push(`${log.step}  ${log.startedAt ?? "(時刻不明)"}  ${log.file}`);
  if (log.session) {
    out.push(`session <…${log.session.tail}>`); // ⚠️ 生 ID は出さない
  }
  out.push("");
  for (const e of log.entries) {
    const exit = e.kind === "shell" && e.exitCode !== null && e.exitCode !== undefined ? ` (exit ${e.exitCode})` : "";
    out.push(`${String(e.seq).padStart(3)} ${MARK[e.kind]} ${e.text}${exit}`);
  }
  out.push("");
  const c = log.counts;
  out.push(`say ${c.say} / edit ${c.edit} / shell ${c.shell}${c.error ? ` / error ${c.error}` : ""}`);
  if (log.usage) {
    const u = log.usage;
    const ratio =
      u.inputTokens && u.cachedInputTokens !== null ? `  cacheRead ${Math.round((u.cachedInputTokens / u.inputTokens) * 100)}%` : "";
    out.push(`tokens in ${(u.inputTokens ?? 0).toLocaleString()} / out ${(u.outputTokens ?? 0).toLocaleString()}${ratio}`);
  }
  return out.join("\n");
}
