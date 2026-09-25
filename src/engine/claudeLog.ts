// `aiw log` の claude 読み取り側。
//
// **読むだけ。新しい記録は作らない。** claude executor が tee した
// `runs/claude/<時刻>-<step>.jsonl` を、provider 固有のイベント語彙のまま要約する。
// 生 session ID は一次資料にだけ残し、構造化した返り値と整形表示には載せない。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { rootPaths } from "./paths.js";
import { redactSession, sessionSecret, toSessionRef, type SessionRef, type SessionSecret } from "./session.js";

export type ClaudeLogEntryKind = "say" | "tool" | "toolResult" | "think" | "denied" | "error" | "other";

export type ClaudeLogEntry = {
  /** JSONL 内の並び順（1 始まり） */
  seq: number;
  kind: ClaudeLogEntryKind;
  /** 1 行の要約 */
  text: string;
};

export type ClaudeLogUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

export type ClaudeRunLog = {
  /** root からの相対パス */
  file: string;
  /** 実行開始時刻（ファイル名由来。ISO 文字列） */
  startedAt: string | null;
  step: string;
  entries: ClaudeLogEntry[];
  counts: Record<ClaudeLogEntryKind, number>;
  /** hash + 末尾のみ。生 ID は持たない */
  session: SessionRef | null;
  model: { requested: string | null; observed: string[] };
  tools: string[];
  permissionMode: string | null;
  claudeCodeVersion: string | null;
  durationMs: number | null;
  numTurns: number | null;
  subtype: string | null;
  isError: boolean | null;
  usage: ClaudeLogUsage | null;
};

/** `runs/claude/` から、そのステップの直近の実行ファイルを選ぶ。 */
export function findClaudeRunFile(root: string, step: string): string | null {
  const dir = path.join(rootPaths(root).runsDir, "claude");
  if (!existsSync(dir)) {
    return null;
  }
  const suffix = `-${step}.jsonl`;
  const hits = readdirSync(dir).filter((f) => f.endsWith(suffix)).sort();
  const last = hits[hits.length - 1];
  return last ? path.join(dir, last) : null;
}

/** ファイル名 `2026-08-21T02-20-36-853Z-implementation.jsonl` から開始時刻を復元する。 */
function startedAtFromName(file: string): string | null {
  const m = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

function flatten(value: unknown, n: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}

function basename(value: unknown): string {
  return String(value ?? "").split(/[/\\]/).pop() ?? "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? "");
  }
  return content
    .map((block: any) => (typeof block === "string" ? block : typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join(" ");
}

function toolText(block: any): string {
  const name = String(block?.name ?? "tool");
  const input = block?.input ?? {};
  if (name === "Bash") {
    return `${name} ${String(input.command ?? "").split(/\r?\n/)[0].trim()}`.trim();
  }
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    const file = basename(input.file_path ?? input.notebook_path);
    return `${name} ${file || "(no path)"}`;
  }
  const representative = input.file_path ?? input.path ?? input.pattern ?? Object.values(input).find((v) => typeof v === "string");
  return `${name}${representative === undefined ? "" : ` ${String(representative)}`}`;
}

function classify(event: any, secret: SessionSecret | null): ClaudeLogEntry[] {
  const type = event?.type;
  if (type === "assistant") {
    if (typeof event.error === "string" || event.is_api_error_message === true) {
      const text = contentText(event.message?.content) || String(event.error ?? "api error");
      return [{ seq: 0, kind: "error", text: flatten(redactSession(text, secret), 120) }];
    }
    const entries: ClaudeLogEntry[] = [];
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block?.type === "text") {
        entries.push({ seq: 0, kind: "say", text: flatten(redactSession(block.text, secret), 240) });
      } else if (block?.type === "thinking") {
        entries.push({ seq: 0, kind: "think", text: "thinking..." });
      } else if (block?.type === "tool_use") {
        entries.push({ seq: 0, kind: "tool", text: flatten(redactSession(toolText(block), secret), 140) });
      }
    }
    return entries;
  }
  if (type === "user") {
    const entries: ClaudeLogEntry[] = [];
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block?.type !== "tool_result") {
        continue;
      }
      const kind = block.is_error === true ? "error" : "toolResult";
      entries.push({ seq: 0, kind, text: flatten(redactSession(contentText(block.content), secret), 120) });
    }
    return entries;
  }
  if (type === "system" && event?.subtype === "permission_denied") {
    const tool = String(event.tool_name ?? "unknown");
    const reason = String(event.decision_reason_type ?? "unknown");
    return [{ seq: 0, kind: "denied", text: flatten(redactSession(`${tool} — ${reason}`, secret), 120) }];
  }
  if (
    (type === "system" && (event?.subtype === "init" || event?.subtype === "thinking_tokens")) ||
    type === "result" ||
    type === "rate_limit_event" ||
    type === "tool_progress"
  ) {
    return [];
  }
  return [{ seq: 0, kind: "other", text: flatten(`${String(type ?? "unknown")}${event?.subtype ? `:${event.subtype}` : ""}`, 80) }];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** JSONL を構造化する。壊れた行は落として読み進める。 */
export function readClaudeRunLog(root: string, file: string): ClaudeRunLog {
  const abs = path.resolve(file);
  const step = path.basename(abs).replace(/\.jsonl$/, "").replace(/^.*Z-/, "");
  const entries: ClaudeLogEntry[] = [];
  const counts: Record<ClaudeLogEntryKind, number> = {
    say: 0,
    tool: 0,
    toolResult: 0,
    think: 0,
    denied: 0,
    error: 0,
    other: 0
  };
  let secret: SessionSecret | null = null;
  let session: SessionRef | null = null;
  let requested: string | null = null;
  let observed: string[] = [];
  let tools: string[] = [];
  let permissionMode: string | null = null;
  let claudeCodeVersion: string | null = null;
  let durationMs: number | null = null;
  let numTurns: number | null = null;
  let subtype: string | null = null;
  let isError: boolean | null = null;
  let usage: ClaudeLogUsage | null = null;

  for (const line of readFileSync(abs, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!secret && typeof event?.session_id === "string") {
      secret = sessionSecret(event.session_id);
      session = toSessionRef(secret);
    }
    if (event?.type === "system" && event?.subtype === "init") {
      requested = typeof event.model === "string" ? event.model : null;
      tools = Array.isArray(event.tools)
        ? event.tools.map((tool: any) => String(typeof tool === "string" ? tool : tool?.name ?? "")).filter(Boolean)
        : [];
      permissionMode = typeof event.permissionMode === "string" ? event.permissionMode : null;
      claudeCodeVersion = typeof event.claude_code_version === "string" ? event.claude_code_version : null;
      continue;
    }
    if (event?.type === "result") {
      subtype = typeof event.subtype === "string" ? event.subtype : null;
      isError = typeof event.is_error === "boolean" ? event.is_error : null;
      durationMs = numberOrNull(event.duration_ms);
      numTurns = numberOrNull(event.num_turns);
      observed = event.modelUsage && typeof event.modelUsage === "object" ? Object.keys(event.modelUsage).sort() : [];
      if (event.usage && typeof event.usage === "object") {
        usage = {
          inputTokens: numberOrNull(event.usage.input_tokens),
          outputTokens: numberOrNull(event.usage.output_tokens),
          cacheReadTokens: numberOrNull(event.usage.cache_read_input_tokens),
          cacheWriteTokens: numberOrNull(event.usage.cache_creation_input_tokens)
        };
      }
      continue;
    }
    for (const entry of classify(event, secret)) {
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
    counts,
    session,
    model: { requested, observed },
    tools,
    permissionMode,
    claudeCodeVersion,
    durationMs,
    numTurns,
    subtype,
    isError,
    usage
  };
}

const MARK: Record<ClaudeLogEntryKind, string> = {
  say: "say ",
  tool: "tool",
  toolResult: "res ",
  think: "think",
  denied: "DENY",
  error: "ERR ",
  other: "    "
};

/** 人間可読の整形。 */
export function formatClaudeRunLog(log: ClaudeRunLog): string {
  const out: string[] = [];
  out.push(`${log.step}  ${log.startedAt ?? "(時刻不明)"}  ${log.file}`);
  out.push(`claude  model ${log.model.requested ?? "(不明)"}  observed ${log.model.observed.join(", ") || "(なし)"}`);
  const session = log.session ? `<…${log.session.tail}>` : "(なし)";
  out.push(
    `session ${session}  tools ${log.tools.join(", ") || "(なし)"}  permission ${log.permissionMode ?? "(不明)"}` +
      (log.claudeCodeVersion ? `  version ${log.claudeCodeVersion}` : "")
  );
  out.push("");
  for (const entry of log.entries) {
    out.push(`${String(entry.seq).padStart(3)} ${MARK[entry.kind]}  ${entry.text}`);
  }
  out.push("");
  const c = log.counts;
  out.push(`say ${c.say} / tool ${c.tool} / result ${c.toolResult} / think ${c.think} / denied ${c.denied} / error ${c.error}`);
  if (log.subtype === null && log.isError === null && log.durationMs === null && log.numTurns === null && log.usage === null) {
    out.push("result イベント無し");
    return out.join("\n");
  }
  out.push(`result ${log.subtype ?? "(不明)"} (is_error ${log.isError ?? "(不明)"})  ${log.durationMs ?? "?"}ms  turns ${log.numTurns ?? "?"}`);
  const u = log.usage;
  const total = u ? (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0;
  const ratio = u && u.cacheReadTokens !== null && total > 0 ? `  cacheRead ${Math.round((u.cacheReadTokens / total) * 100)}%` : "";
  out.push(
    `tokens in ${(u?.inputTokens ?? 0).toLocaleString()} / out ${(u?.outputTokens ?? 0).toLocaleString()} / ` +
      `cacheRead ${(u?.cacheReadTokens ?? 0).toLocaleString()} / cacheWrite ${(u?.cacheWriteTokens ?? 0).toLocaleString()}${ratio}`
  );
  return out.join("\n");
}
