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
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execStep } from "../src/engine/engine.js";
import { createCodexExecutor, summarize, usageFrom } from "../src/engine/executors/codex.js";
import { visibleOnScreen } from "../src/engine/executors/index.js";
import { readEventLog } from "../src/engine/observed.js";
import { assembleStepPrompt } from "../src/engine/promptAssembly.js";
import { rootPaths } from "../src/engine/paths.js";
import type { ExecutorProgress } from "../src/engine/executors/types.js";
import { makeRoot, setStep } from "./helpers.js";

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
// ⚠️ 2026-09-17（BL-221 (3)）: codex.ts は自前タイマーを持たなくなった。総上限は watchdog が signal で撃つので、
// ここでも「上限を過ぎて signal が撃たれた」形で見る（以前は executor 内の setTimeout が撃っていた）。
test("96: a timeout is transient, not a permanent failure", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["implementation"];
  const { launch, captured } = fakeCodex([{ type: "thread.started", thread_id: THREAD_ID }], { hang: true });
  const watchdog = new AbortController();
  setTimeout(() => watchdog.abort(), 40); // 総上限 30ms を過ぎてから watchdog が撃つ

  const result = await createCodexExecutor({ launch }).execute({
    root,
    config,
    step,
    projectRoot: root,
    timeoutMs: 30,
    signal: watchdog.signal
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "transient", "再試行に意味がある種類として分類する");
  assert.equal((result.meta as any).timedOut, true);
  assert.ok(captured.killed >= 1, "子プロセスを止める");
  assert.match(result.error ?? "", /中断されました/);
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

  // 発言は**画面に出る既定の唯一の種類**なので、他より長く見せる。
  // ただし全文は流さない（詳細は runs/ の JSONL）。
  const msg = summarize({ type: "item.completed", item: { type: "agent_message", text: long } }, null);
  assert.ok((msg?.text.length ?? 0) <= 240, `全文を流さない（実際 ${msg?.text.length}）`);
  assert.ok((msg?.text.length ?? 0) > 90, "1行80文字では削りすぎるので広げてある");

  // 複数行の発言は1行へ畳む（画面が縦に流れないように）
  const multi = summarize({ type: "item.completed", item: { type: "agent_message", text: "一行目\n\n二行目   三行目" } }, null);
  assert.equal(multi?.text, "一行目 二行目 三行目");

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

// Test 107 — モデルの pin。設定があれば -m を渡し、無ければ渡さない。
//
// ⚠️ codex は**使ったモデルをイベントにもログにも残さない**（実タスク 70 イベントを
// 走査して "model" の出現 0 件・2026-08-19 実測）。したがって記録できるのは
// **指定値であって実測値ではない**。フィールド名 modelRequested がその区別を持つ。
test("107: a pinned model is passed with -m, and its absence is recorded, not hidden", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["implementation"];

  // 指定あり
  const pinned = fakeCodex(OK_EVENTS);
  const withModel = await createCodexExecutor({ launch: pinned.launch }).execute({
    root,
    config: { ...config, settings: { ...config.settings, codexModel: "gpt-5.4-mini" } },
    step,
    projectRoot: root
  });
  const i = pinned.captured.argv.indexOf("-m");
  assert.ok(i > 0, "-m が argv に入る");
  assert.equal(pinned.captured.argv[i + 1], "gpt-5.4-mini");
  assert.equal((withModel.meta as any).modelRequested, "gpt-5.4-mini");

  // 指定なし → -m を渡さない。ただし **"unspecified" と明示記録する**
  const bare = fakeCodex(OK_EVENTS);
  const noModel = await createCodexExecutor({ launch: bare.launch }).execute({ root, config, step, projectRoot: root });
  assert.equal(bare.captured.argv.includes("-m"), false, "指定が無ければ渡さない");
  assert.equal(
    (noModel.meta as any).modelRequested,
    "unspecified",
    "null や欠落にしない（「未指定と記録した」と「記録が無い」を区別する）"
  );
});

// Test 108 — **画面に出すのは codex の発言だけ**（+ error）。shell / edit / thinking は出さない。
//
// 実測: 大きめのタスク 1 本で 119 イベント・shell 36 回。全種類を流すと画面がコマンドで埋まり、
// モデルが何を言っているかが読めなくなる。
//
// ⚠️ **error は既定でも出す。** 失敗を黙って通さないのはこのコードベースの規律であり、
// 「発言だけ」を字義どおり適用して例外を握り潰すのは筋が違う。
// 捨てているのは表示だけで、全イベントは runs/ の JSONL に残る。
test("108: the screen shows codex's own words (and errors), not its shell traffic", () => {
  const kinds: ExecutorProgress["kind"][] = ["thinking", "edit", "shell", "message", "tokens", "error"];
  const shown = (verbose: boolean) => kinds.filter((k) => visibleOnScreen(k, verbose));

  assert.deepEqual(shown(false), ["message", "error"], "既定は発言と error のみ");
  assert.deepEqual(shown(true), kinds, "--verbose では全種類");
});

// ---------------------------------------------------------------------------------------------
// BL-221（executor 対称化の小枠・2026-09-17）: 同じ判定が codex.ts / claude.ts で分岐していた箇所を揃えた。
// ---------------------------------------------------------------------------------------------

// Test 173 — **abort 済みの signal を渡されたら起動しない。**
// ⚠️ abort 済みの AbortSignal に listener を足しても abort イベントは二度と来ない。以前の codex.ts は listener を
// 足すだけだったので、watchdog が起動前に abort した場合（externalSignal が既に aborted の分岐）でも最後まで走った。
// M5（aiw auto）の停止はここに依存する。
test("173: an already-aborted signal never launches codex", async () => {
  const { root, config } = readyRoot();
  const { launch, captured } = fakeCodex(OK_EVENTS);
  let launched = 0;
  const counting = (argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
    launched += 1;
    return launch(argv, o);
  };
  const stopped = new AbortController();
  stopped.abort();

  const result = await createCodexExecutor({ launch: counting }).execute({
    root,
    config,
    step: config.steps["implementation"],
    projectRoot: root,
    signal: stopped.signal,
    timeoutMs: 60_000
  });

  assert.equal(launched, 0, "プロセスを起動しない");
  assert.equal(captured.stdin, "", "プロンプトも送らない");
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "transient", "failureKind の語彙は増やさない（中断は transient）");
  assert.equal((result.meta as any).launched, false);
  assert.match(result.error ?? "", /起動前に中断/);
});

// Test 174 — **実行中に外から abort すると kill される**（engine 経由）。
// あわせて M5 設計への申し送りを事実として固定する: 外部中断は watchdog の発火ではないので
// Event Log は「transient で timeoutKind なし」になり、rate limit 等の transient と executor の結果からは区別できない。
test("174: an external abort mid-run kills codex, and is logged as transient without a timeoutKind", async () => {
  const { root, config } = readyRoot();
  setStep(root, "implementation");
  const { launch, captured } = fakeCodex([{ type: "thread.started", thread_id: THREAD_ID }], { hang: true });
  const human = new AbortController();
  setTimeout(() => human.abort(), 30);

  const result = await execStep(root, config, "implementation", {
    executor: createCodexExecutor({ launch }),
    signal: human.signal
  });

  assert.ok(captured.killed >= 1, "子プロセスを止める");
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "transient");
  const log = readEventLog(root);
  assert.ok(Array.isArray(log));
  const failed = (log as Array<Record<string, any>>).filter((r) => r.event === "exec.failed").pop();
  assert.equal(failed?.failureKind, "transient");
  assert.equal(failed?.meta?.timeoutKind, undefined, "外部中断は総上限でも無進行でもない（firedKind は null）");
});

// Test 175 — cwd の内外判定は **8.3 短縮名を正式表記へ直してから**比べる（claude.ts と同じ・2026-09-04 の実測）。
test("175: a short-name runtime root inside the workspace is not mistaken for outside", async (t) => {
  const { root, config } = readyRoot();
  const longRepo = realpathSync.native(path.resolve(root, ".."));
  if (path.resolve(root, "..") === longRepo) {
    t.skip("この環境の一時ディレクトリは短縮名ではないので再現できない（Windows の TOMO~1.SAK 形で再現する）");
    return;
  }
  const { launch, captured } = fakeCodex(OK_EVENTS);
  const result = await createCodexExecutor({ launch }).execute({
    root, // 短縮名の表記
    config,
    step: config.steps["implementation"],
    projectRoot: longRepo // git が返す長い表記
  });
  assert.equal(result.ok, true);
  assert.equal(captured.argv.includes("--add-dir"), false, "配下にあるのに --add-dir を足さない");
  assert.equal((result.meta as any).addDir, null);
});

// Test 176 — 設定値は有限の正数・空白でない文字列だけを通す（claude.ts / engine と同じ強さ）。
test("176: a zero timeout and a blank codexHome fall back to the defaults instead of misbehaving", async () => {
  const { root, config } = readyRoot();
  const { launch, captured } = fakeCodex(OK_EVENTS);
  const result = await createCodexExecutor({ launch }).execute({
    root,
    config: { ...config, settings: { ...config.settings, executorTimeoutMs: 0, codexHome: "   " } },
    step: config.steps["implementation"],
    projectRoot: root
  });
  assert.equal(result.ok, true, "0 の上限で「実測時間 ≥ 上限」に化けて即中断扱いにならない");
  assert.equal(path.basename(String(captured.env.CODEX_HOME)), ".codex-home", "空白の codexHome は既定へ落ちる");
});
