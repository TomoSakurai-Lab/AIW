import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findClaudeRunFile, formatClaudeRunLog, readClaudeRunLog } from "../src/engine/claudeLog.js";
import { rootPaths } from "../src/engine/paths.js";
import { findLatestRun } from "../src/engine/runLog.js";
import { makeRoot } from "./helpers.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_ID = "513affec-1234-5678-9abc-0123456789ab";

function writeRun(root: string, provider: "codex" | "claude", name: string, events: unknown[] | string): string {
  const dir = path.join(rootPaths(root).runsDir, provider);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const text = typeof events === "string" ? events : events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  writeFileSync(file, text, "utf8");
  return file;
}

const RUN = [
  {
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    model: "claude-opus-5",
    tools: ["Read", "Bash", { name: "Edit" }],
    permissionMode: "dontAsk",
    claude_code_version: "2.1.251"
  },
  {
    type: "assistant",
    session_id: SESSION_ID,
    message: {
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: `まず\n確認します ${SESSION_ID}` },
        { type: "tool_use", name: "Bash", input: { command: "npm test\necho later" } },
        { type: "tool_use", name: "Edit", input: { file_path: "C:/repo/src/file.ts" } },
        { type: "tool_use", name: "Read", input: { file_path: "C:/repo/context.md" } }
      ]
    }
  },
  { type: "user", session_id: SESSION_ID, message: { content: [{ type: "tool_result", content: "done\nwell", is_error: false }] } },
  { type: "user", session_id: SESSION_ID, message: { content: [{ type: "tool_result", content: "failed", is_error: true }] } },
  { type: "system", subtype: "permission_denied", session_id: SESSION_ID, tool_name: "Bash", decision_reason_type: "mode" },
  { type: "system", subtype: "thinking_tokens", session_id: SESSION_ID },
  { type: "rate_limit_event", session_id: SESSION_ID },
  { type: "tool_progress", session_id: SESSION_ID },
  {
    type: "result",
    session_id: SESSION_ID,
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    num_turns: 2,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 700, cache_creation_input_tokens: 200 },
    modelUsage: { "claude-opus-5": {}, "claude-haiku-4-5": {} }
  }
];

function cli(root: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [path.join(PKG, "node_modules", "tsx", "dist", "cli.js"), path.join(PKG, "src", "cli.ts"), "--root", root, "log", ...args],
    { encoding: "utf8", windowsHide: true, timeout: 120_000, cwd: PKG }
  );
  assert.equal(result.error, undefined, `aiw log を起動できない: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Test 221 — Claude の直近 run を選び、実物 CLI が整形して exit 0。
test("221: claude log picks the latest run and the real CLI formats it", () => {
  const { root } = makeRoot();
  writeRun(root, "claude", "2026-09-24T01-00-00-000Z-implementation.jsonl", RUN);
  const newest = writeRun(root, "claude", "2026-09-25T06-13-41-881Z-implementation.jsonl", RUN);
  assert.equal(findClaudeRunFile(root, "implementation"), newest);
  assert.equal(findClaudeRunFile(root, "review"), null);

  const result = cli(root, "implementation");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /claude  model claude-opus-5/);
  assert.match(result.stdout, /npm test/);
  assert.match(result.stdout, /result success \(is_error false\)/);
});

// Test 222 — 構造化出力と整形表示は SessionRef だけを持つ。
test("222: structured and formatted claude logs never expose a raw session id", () => {
  const { root } = makeRoot();
  const file = writeRun(root, "claude", "2026-09-25T06-13-41-881Z-review.jsonl", RUN);
  const log = readClaudeRunLog(root, file);
  assert.equal(JSON.stringify(log).includes(SESSION_ID), false);
  assert.equal(formatClaudeRunLog(log).includes(SESSION_ID), false);
  assert.equal(log.session?.tail, "89ab");
  assert.match(log.session?.hash ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(readFileSync(file, "utf8").includes(SESSION_ID), true, "一次資料は加工しない");

});

// Test 223 — provider 固有のイベントを行とメタ情報へ写し、ノイズ3種は捨てる。
test("223: claude events are classified, metadata is retained, and noisy events are omitted", () => {
  const { root } = makeRoot();
  const file = writeRun(root, "claude", "2026-09-25T06-13-41-881Z-review.jsonl", RUN);
  const log = readClaudeRunLog(root, file);
  assert.deepEqual(log.entries.map((entry) => entry.kind), ["think", "say", "tool", "tool", "tool", "toolResult", "error", "denied"]);
  assert.deepEqual(log.entries.map((entry) => entry.text).slice(2, 5), ["Bash npm test", "Edit file.ts", "Read C:/repo/context.md"]);
  assert.equal(log.entries.some((entry) => /thinking_tokens|rate_limit_event|tool_progress/.test(entry.text)), false);
  assert.deepEqual(log.model, { requested: "claude-opus-5", observed: ["claude-haiku-4-5", "claude-opus-5"] });
  assert.deepEqual(log.tools, ["Read", "Bash", "Edit"]);
  assert.equal(log.permissionMode, "dontAsk");
  assert.equal(log.claudeCodeVersion, "2.1.251");
  assert.deepEqual(log.usage, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 700, cacheWriteTokens: 200 });
  assert.equal(log.subtype, "success");
  assert.equal(log.isError, false);
});

// Test 224 — cacheRead 比は Claude 定義（cacheRead / 総入力）。
test("224: claude rendering uses the provider-specific cache ratio", () => {
  const { root } = makeRoot();
  const file = writeRun(root, "claude", "2026-09-25T06-13-41-881Z-review.jsonl", RUN);
  const rendered = formatClaudeRunLog(readClaudeRunLog(root, file));
  assert.match(rendered, /tokens in 100 \/ out 50 \/ cacheRead 700 \/ cacheWrite 200 {2}cacheRead 70%/);
  assert.match(rendered, /say 1 \/ tool 3 \/ result 1 \/ think 1 \/ denied 1 \/ error 1/);
});

// Test 225 — result の無い中断 run も例外にせず、欠損のまま示す。
test("225: an interrupted claude log without a result remains readable", () => {
  const { root } = makeRoot();
  const file = writeRun(root, "claude", "2026-09-25T06-13-41-881Z-review.jsonl", RUN.slice(0, 2));
  const log = readClaudeRunLog(root, file);
  assert.equal(log.usage, null);
  assert.equal(log.durationMs, null);
  assert.equal(log.subtype, null);
  assert.equal(log.isError, null);
  assert.match(formatClaudeRunLog(log), /result イベント無し$/);
});

// Test 226 — 壊れた行を飛ばして後続を読む。
test("226: a malformed claude JSONL line is skipped", () => {
  const { root } = makeRoot();
  const text = `${JSON.stringify(RUN[0])}\n{ broken\n${JSON.stringify(RUN[1])}\n`;
  const file = writeRun(root, "claude", "2026-09-25T06-13-41-881Z-review.jsonl", text);
  assert.deepEqual(readClaudeRunLog(root, file).entries.map((entry) => entry.kind), ["think", "say", "tool", "tool", "tool"]);
});

// Test 227 — 両 provider のうち新しい basename を選び、同値は claude。
test("227: latest-run selection compares codex and claude timestamps", () => {
  const { root } = makeRoot();
  writeRun(root, "codex", "2026-09-25T05-00-00-000Z-review.jsonl", []);
  const claude = writeRun(root, "claude", "2026-09-25T06-00-00-000Z-review.jsonl", RUN);
  assert.deepEqual(findLatestRun(root, "review"), { provider: "claude", file: claude });

  const codex = writeRun(root, "codex", "2026-09-25T07-00-00-000Z-review.jsonl", []);
  assert.deepEqual(findLatestRun(root, "review"), { provider: "codex", file: codex });

  const same = writeRun(root, "claude", "2026-09-25T07-00-00-000Z-review.jsonl", RUN);
  assert.deepEqual(findLatestRun(root, "review"), { provider: "claude", file: same });
});

// Test 228 — --raw は選ばれた Claude JSONL をバイト列の加工なしで出す。
test("228: --raw writes the selected claude JSONL unchanged", () => {
  const { root } = makeRoot();
  const file = writeRun(root, "claude", "2026-09-25T06-13-41-881Z-review.jsonl", RUN);
  const result = cli(root, "review", "--raw");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, readFileSync(file, "utf8"));
});

// Test 229 — 両 provider に記録が無ければ null。
test("229: a missing run in both provider directories returns null", () => {
  const { root } = makeRoot();
  assert.equal(findLatestRun(root, "review"), null);
});
