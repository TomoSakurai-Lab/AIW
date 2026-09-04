// claude executor の統合面（M4 段階1-1）。
//
// 個々の性質は claude-executor.test.ts が見る。ここで見るのは
// **エンジンと繋いだときに何が Event Log へ残るか / 残らないか**。
//
// 故障注入リスト（設計文書 課題K）のうち、ここで固定するもの:
//   #3 実行途中で kill → 成果物ファイルだけから fresh 再実行（unit 側 Test 136 と対）
//   #4 タイムアウト → transient。**どちらの見張りが撃ったか**を潰さない
//   #5 生 ID grep（Event Log 全文）
//   #9 exit 0 + 成果物なし → executor は成功を主張せず file-exists が halt
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execStep, runStep } from "../src/engine/engine.js";
import { createClaudeExecutor } from "../src/engine/executors/claude.js";
import { rootPaths } from "../src/engine/paths.js";
import { makeRoot, setStep } from "./helpers.js";

const SESSION_ID = "513affec-7f0d-4a5b-9d5e-1c2b3a4d5e6f";

const INIT = {
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  tools: ["Read", "Grep", "Glob", "Edit"],
  model: "claude-opus-5[1m]",
  permissionMode: "dontAsk"
};

function result(extra: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: SESSION_ID,
    usage: {
      input_tokens: 4212,
      output_tokens: 318,
      cache_read_input_tokens: 39561,
      cache_creation_input_tokens: 1204
    },
    modelUsage: { "claude-opus-5": {}, "claude-haiku-4-5-20251001": {} },
    permission_denials: [],
    ...extra
  };
}

/** stdout へ stream-json を流して閉じる偽 claude。`onStdin` で成果物の生成を模す。 */
function fake(lines: unknown[], onStdin?: () => void, opts: { code?: number; hang?: boolean } = {}) {
  const state = { launches: 0 };
  const launch = () => {
    state.launches += 1;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const handlers: { close?: (c: number | null, s: NodeJS.Signals | null) => void } = {};
    stdin.on("finish", () => {
      onStdin?.();
      for (const l of lines) {
        stdout.write(`${JSON.stringify(l)}\n`);
      }
      if (!opts.hang) {
        stdout.end();
        handlers.close?.(opts.code ?? 0, null);
      }
    });
    return {
      stdin,
      stdout,
      stderr,
      kill: () => handlers.close?.(null, "SIGTERM" as NodeJS.Signals),
      on(event: string, cb: any) {
        if (event === "close") handlers.close = cb;
      }
    };
  };
  return { launch, state };
}

function ready() {
  const { root, config } = makeRoot();
  mkdirSync(path.join(root, ".claude-home"), { recursive: true });
  setStep(root, "improve-check");
  return { root, config };
}

function lastEvent(root: string, type: string): any {
  const lines = readFileSync(rootPaths(root).eventLog, "utf8").trim().split("\n").filter(Boolean);
  const hit = lines.map((l) => JSON.parse(l)).filter((r) => r.event === type);
  return hit[hit.length - 1];
}

// Test 138 — Event Log に **観測できるものは観測値として**載る。
//
// codex との最大の差がここ: `modelObserved` が**実測**で残る（codex は指定値しか残せない）。
// effort は逆に observed が取れないので requested だけ——非対称をフィールド名で持たせている。
test("138: exec.completed carries claude's tokens, the observed models and the requested effort", async () => {
  const { root, config } = ready();
  const { launch } = fake([INIT, result()]);
  const settings = { ...config.settings, claudeModel: "claude-opus-5", claudeEffort: "low" };

  await execStep(root, { ...config, settings }, "improve-check", { executor: createClaudeExecutor({ launch }) });

  const ev = lastEvent(root, "exec.completed");
  assert.equal(ev.executor, "claude");
  assert.equal(ev.inputTokens, 4212);
  assert.equal(ev.outputTokens, 318);
  assert.equal(ev.cacheReadTokens, 39561, "cacheRead / input 比の実測に使う値（課題D の再検討条件）");
  assert.equal(ev.cacheWriteTokens, 1204);
  assert.equal(ev.reasoningTokens, null, "測れないものは null のまま");
  assert.equal(ev.meta.modelRequested, "claude-opus-5");
  assert.deepEqual(ev.meta.modelObserved, ["claude-haiku-4-5-20251001", "claude-opus-5"]);
  assert.equal(ev.meta.effortRequested, "low");
  assert.deepEqual(ev.meta.toolsObserved, ["Edit", "Glob", "Grep", "Read"], "どの制限で走ったかを残す");
});

// Test 139 — **故障注入 #5: 生 ID grep。** Event Log 全文に生 session ID が出ない。
//
// ⚠️ 境界: claude が吐く **生 JSONL（runs/claude/）には session_id が入っている**。
// それは一次資料なのでそのまま保存してよい。防衛対象は aiw が転記・要約する側。
test("139: the raw session id never appears in the Event Log", async () => {
  const { root, config } = ready();
  const { launch } = fake([INIT, result({ is_error: true, result: `boom ${SESSION_ID}` })], undefined, { code: 1 });
  const shown: string[] = [];

  await execStep(root, config, "improve-check", {
    executor: createClaudeExecutor({ launch }),
    onProgress: (e) => shown.push(e.text)
  });

  const log = readFileSync(rootPaths(root).eventLog, "utf8");
  assert.equal(log.includes(SESSION_ID), false, "Event Log に生 ID があってはいけない");
  assert.match(log, /sha256:[0-9a-f]{64}/, "hash では残っている");
  assert.equal(shown.join("\n").includes(SESSION_ID), false, "表示経路にも出ない");

  const ev = lastEvent(root, "exec.failed");
  const jsonl = readFileSync(path.join(root, ev.meta.jsonl), "utf8");
  assert.equal(jsonl.includes(SESSION_ID), true, "一次資料は runs/ に隔離して保存する");
});

// Test 140 — **故障注入 #4: 無進行タイムアウト。**
//
// claude.ts は**タイマーを持たない**（設計の指示）。総上限と無進行の見張りは
// engine/watchdog.ts が持ち、executor は onProgress を流すだけで idle 検出が効く。
// ここが通ることが「executor 側にタイマーを足さなくてよい」の根拠になる。
test("140: the engine's idle watchdog fires for claude too, and the kind is not flattened", async () => {
  const { root, config } = ready();
  // INIT だけ流して黙り込む（stall の形）
  const { launch } = fake([INIT], undefined, { hang: true });
  const settings = { ...config.settings, codexIdleTimeoutMs: 120, codexTimeoutMs: 60_000 };

  const outcome = await execStep(root, { ...config, settings }, "improve-check", {
    executor: createClaudeExecutor({ launch })
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureKind, "transient", "タイムアウトは transient。permanent に化けない");
  assert.equal((outcome.meta as any).timeoutKind, "idle", "総上限と無進行を1つに潰さない");
  assert.match(outcome.error ?? "", /無進行/);

  const ev = lastEvent(root, "exec.failed");
  assert.equal(ev.failureKind, "transient");
  assert.equal(ev.meta.timeoutKind, "idle");
  assert.ok(ev.meta.progressEvents >= 0, "沈黙の実測も残る（閾値見直しの一次資料）");
});

// Test 141 — **故障注入 #9: exit 0 + 成果物なし。**
// executor は成功を主張せず（outputs 空）、file-exists が halt する。
//
// ⚠️ **このテストを消すこと自体が違反**（設計文書 課題K #9・codex #9 と同じ固定点）。
test("141: exit 0 with no artifact still halts at file-exists", async () => {
  const { root, config } = ready();
  const { launch } = fake([INIT, result()]); // 何も書かない
  rmSync(path.join(root, "current-status.json"), { force: true });

  const outcome = await execStep(root, config, "improve-check", { executor: createClaudeExecutor({ launch }) });
  assert.equal(outcome.ok, true, "プロセスは完走している");
  assert.deepEqual(outcome.outputs, [], "executor は成果物を主張しない");

  const run = runStep(root, config, "improve-check");
  assert.equal(run.kind, "halted", "判定は validator の仕事");
  assert.match(String((run as any).message ?? ""), /current-status\.json/);
});
