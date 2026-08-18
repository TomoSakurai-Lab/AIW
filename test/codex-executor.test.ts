// codex executor（M3 段階1）の中核の性質。
//
// 実物の codex は起動しない。`launch` を差し替えて JSONL を流し込み、
// **executor が何を渡し / 何を残し / 何を残さないか**だけを見る。
//
// ここで固定するのは設計文書の防衛線そのもの:
//   - 契約再記述禁止（F-3）: 渡すのは組み立て済みプロンプトのみ。1文字も足さない
//   - 生 session ID を残さない（F-2）: meta にも表示経路にも出ない
//   - exit 0 は成功ではない（C-3）: 成果物を検証しない
//   - タイムアウトの二重判定（C-2 / KI-08）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createCodexExecutor, summarize, usageFrom } from "../src/engine/executors/codex.js";
import { assembleStepPrompt } from "../src/engine/promptAssembly.js";
import { rootPaths } from "../src/engine/paths.js";
import type { ExecutorProgress } from "../src/engine/executors/types.js";
import { makeRoot } from "./helpers.js";

const THREAD_ID = "01a013b1-80e9-7c71-9460-305caf414464";

/** JSONL を流して閉じる偽 codex。`lines` を stdout へ、`code` で終了する。 */
function fakeCodex(lines: unknown[], opts: { code?: number; hang?: boolean } = {}) {
  const captured = { stdin: "", argv: [] as string[], env: {} as NodeJS.ProcessEnv, killed: 0 };
  const launch = (argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
    captured.argv = argv;
    captured.env = o.env;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on("data", (c) => (captured.stdin += String(c)));
    const handlers: { close?: (c: number | null, s: NodeJS.Signals | null) => void } = {};
    setTimeout(() => {
      for (const l of lines) {
        stdout.write(`${JSON.stringify(l)}\n`);
      }
      stdout.end();
      if (!opts.hang) {
        handlers.close?.(opts.code ?? 0, null);
      }
    }, 1);
    return {
      stdin,
      stdout,
      stderr,
      kill: () => {
        captured.killed += 1;
        handlers.close?.(null, "SIGTERM" as NodeJS.Signals);
      },
      on(event: string, cb: any) {
        if (event === "close") handlers.close = cb;
      }
    };
  };
  return { launch, captured };
}

function readyRoot() {
  const { root, config } = makeRoot();
  mkdirSync(path.join(root, ".codex-home"), { recursive: true }); // login 済みの体
  return { root, config };
}

const OK_EVENTS = [
  { type: "thread.started", thread_id: THREAD_ID },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "i0", type: "file_change", changes: [{ path: "C:/x/src/Grid.tsx" }] } },
  { type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } },
  {
    type: "turn.completed",
    usage: { input_tokens: 26539, cached_input_tokens: 13056, cache_write_input_tokens: 0, output_tokens: 109, reasoning_output_tokens: 42 }
  }
];

// Test 93 — **契約再記述禁止（F-3）。** 渡すのは組み立て済みプロンプトそのもの。
test("93: the executor ships the assembled prompt verbatim on stdin, adding nothing", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["implementation"];
  const { launch, captured } = fakeCodex(OK_EVENTS);

  await createCodexExecutor({ launch }).execute({ root, config, step, projectRoot: root });

  const expected = assembleStepPrompt(root, "implementation", step).text;
  assert.equal(captured.stdin, expected, "1文字も足さない / 削らない");

  // プロンプトは argv ではなく stdin。argv の末尾は "-"（stdin から読ませる指定）
  assert.equal(captured.argv[captured.argv.length - 1], "-");
  assert.equal(captured.argv.some((a) => a.includes("# Current Phase")), false, "argv へ本文を載せない");
  // shell を経由しないための絶対パス起動（KI-08）
  assert.match(captured.argv[0], /codex[\\/]bin[\\/]codex\.js$/);
});

// Test 94 — **生 session ID を残さない（F-2）。** meta にも onProgress にも出ない。
test("94: the raw thread id never reaches meta or the progress stream", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["implementation"];
  const { launch } = fakeCodex([...OK_EVENTS, { type: "error", message: `boom in ${THREAD_ID}` }]);
  const seen: ExecutorProgress[] = [];

  const result = await createCodexExecutor({ launch }).execute({
    root,
    config,
    step,
    projectRoot: root,
    onProgress: (e) => seen.push(e)
  });

  const metaJson = JSON.stringify(result.meta);
  assert.equal(metaJson.includes(THREAD_ID), false, "meta に生 ID が混ざってはいけない");
  assert.match(metaJson, /"hash":"sha256:[0-9a-f]{64}"/, "hash では残す（照合できること）");
  assert.match(metaJson, /"tail":"4464"/);

  const shown = seen.map((e) => e.text).join("\n");
  assert.equal(shown.includes(THREAD_ID), false, "表示経路にも出さない");
  assert.match(shown, /<session:4464>/, "error 本文に紛れた分は伏せて出す");

  // ⚠️ 境界: **codex が吐く生 JSONL には thread_id が入っている。**
  // それを runs/ へそのまま保存するのは許容（一次資料）。
  // 防衛対象は「aiw が転記・要約する側」。ここでその境界を明示しておく。
  const jsonl = readFileSync(path.join(rootPaths(root).root, String((result.meta as any).jsonl)), "utf8");
  assert.equal(jsonl.includes(THREAD_ID), true, "生 JSONL は一次資料なのでそのまま保存する");
});

// Test 95 — **exit 0 は成功ではない（C-3）。** executor は成果物を検証しない。
test("95: exit 0 reports process completion only, never artifact success", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["implementation"];
  // 何も書かずに終わる（read-only 拒否パターンと同じ形）
  const { launch } = fakeCodex([
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "item.completed", item: { id: "i0", type: "agent_message", text: "I can't write; read-only." } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }
  ]);

  const result = await createCodexExecutor({ launch }).execute({ root, config, step, projectRoot: root });

  assert.equal(result.ok, true, "プロセスは完走している");
  assert.deepEqual(result.outputs, [], "executor は成果物を主張しない");
  assert.equal(result.failureKind, undefined);
  // 成果物が無いことの検出は file-exists validator の仕事（aiw run 側）。
});

// Test 96 — タイムアウトは transient。**failed に化けない**（C-2 / KI-08）。
test("96: a timeout is transient, not a permanent failure", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["implementation"];
  const { launch, captured } = fakeCodex([{ type: "thread.started", thread_id: THREAD_ID }], { hang: true });

  const result = await createCodexExecutor({ launch }).execute({
    root,
    config,
    step,
    projectRoot: root,
    timeoutMs: 30
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "transient", "再試行に意味がある種類として分類する");
  assert.equal((result.meta as any).timedOut, true);
  assert.ok(captured.killed >= 1, "子プロセスを止める");
  assert.match(result.error ?? "", /タイムアウト/);
});

// Test 97 — 隔離 CODEX_HOME が無ければ permanent で止める。
//
// 黙って ~/.codex へフォールバックしない。アプリの設定を汚す実害が実測されているため。
test("97: a missing isolated CODEX_HOME fails permanently instead of falling back", async () => {
  const { root, config } = makeRoot(); // .codex-home を作らない
  const step = config.steps["implementation"];
  const { launch, captured } = fakeCodex(OK_EVENTS);

  const result = await createCodexExecutor({ launch }).execute({ root, config, step, projectRoot: root });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "permanent");
  assert.match(result.error ?? "", /codex login/);
  assert.deepEqual(captured.argv, [], "起動そのものをしない");
});

// Test 98 — 表示は種別と対象の1行要約のみ。全文を流さない（課題I）。
test("98: progress lines summarize the event, they do not stream the content", () => {
  const long = "x".repeat(500);
  assert.deepEqual(summarize({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a/b/Grid.tsx" }] } }, null), {
    kind: "edit",
    text: "edit: Grid.tsx"
  });
  assert.deepEqual(summarize({ type: "item.started", item: { type: "reasoning" } }, null), {
    kind: "thinking",
    text: "thinking..."
  });
  assert.deepEqual(summarize({ type: "turn.completed", usage: { input_tokens: 26539, output_tokens: 109 } }, null), {
    kind: "tokens",
    text: "tokens: in 26.5K / out 109"
  });

  const msg = summarize({ type: "item.completed", item: { type: "agent_message", text: long } }, null);
  assert.ok((msg?.text.length ?? 0) <= 90, `全文を流さない（実際 ${msg?.text.length}）`);

  // 開始と完了で二重に出さない
  assert.equal(summarize({ type: "item.started", item: { type: "file_change", changes: [] } }, null), null);
});

// Test 99 — usage の写し取り。Event Log の token 全件 null をここで解消する（B-4）。
test("99: usage maps onto the Event Log token fields", () => {
  const u = usageFrom({
    type: "turn.completed",
    usage: { input_tokens: 26539, cached_input_tokens: 13056, cache_write_input_tokens: 0, output_tokens: 109, reasoning_output_tokens: 42 }
  });
  assert.deepEqual(u, {
    inputTokens: 26539,
    outputTokens: 109,
    cacheReadTokens: 13056,
    cacheWriteTokens: 0,
    reasoningTokens: 42
  });
  assert.equal(usageFrom({ type: "turn.started" }), null);
  // 欠けている値は 0 に丸めず null（「測れなかった」と「0 だった」を混ぜない）
  assert.deepEqual(usageFrom({ usage: { input_tokens: 5 } })?.outputTokens, null);
});
