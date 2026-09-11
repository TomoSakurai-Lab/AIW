// claude executor（M4 段階1-1）の中核の性質。
//
// 実物の claude.exe は起動しない。`launch` を差し替えて stream-json を流し込み、
// **executor が何を渡し / 何を残し / 何を残さないか**だけを見る。
//
// ここで固定するのは設計文書の防衛線そのもの:
//   - 契約再記述禁止: 渡すのは組み立て済みプロンプトのみ。1文字も足さない
//   - 生 session ID を残さない: meta にも表示経路にも出ない（露出経路は codex より多い）
//   - exit 0 / is_error:false は成功ではない（§9-2 実測）
//   - ツール制限は**宣言から導く**。Write は渡さない。Edit は成果物ファイルの列挙
//   - env は許可リスト。親セッションの ANTHROPIC_* / CLAUDE_* を子へ渡さない
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  claudeEntrypoint,
  claudeEnv,
  classifyFailure,
  createClaudeExecutor,
  allowRules,
  denialSummary,
  modelsObserved,
  summarize,
  toolSet,
  toPosixAbsolute,
  usageFrom
} from "../src/engine/executors/claude.js";
import { assembleStepPrompt } from "../src/engine/promptAssembly.js";
import { rootPaths } from "../src/engine/paths.js";
import type { ExecutorProgress } from "../src/engine/executors/types.js";
import type { WorkflowStep } from "../src/engine/types.js";
import { makeRoot } from "./helpers.js";

const SESSION_ID = "513affec-7f0d-4a5b-9d5e-1c2b3a4d5e6f";

/** stream-json を流して閉じる偽 claude。`lines` を stdout へ、`code` で終了する。 */
function fakeClaude(lines: unknown[], opts: { code?: number; hang?: boolean } = {}) {
  const captured = { stdin: "", argv: [] as string[], env: {} as NodeJS.ProcessEnv, cwd: "", killed: 0 };
  const launch = (argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
    captured.argv = argv;
    captured.env = o.env;
    captured.cwd = o.cwd;
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
  mkdirSync(path.join(root, ".claude-home"), { recursive: true }); // login 済みの体
  return { root, config };
}

const INIT = {
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  tools: ["Read", "Grep", "Glob", "Edit"],
  model: "claude-opus-5[1m]",
  permissionMode: "dontAsk",
  claude_code_version: "2.1.251"
};

const RESULT = {
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
  modelUsage: { "claude-opus-5": { inputTokens: 4212 }, "claude-haiku-4-5-20251001": { inputTokens: 91 } },
  permission_denials: []
};

const OK_EVENTS = [
  INIT,
  {
    type: "assistant",
    session_id: SESSION_ID,
    message: { model: "claude-opus-5", content: [{ type: "text", text: "判定は ready-for-reflection です" }] }
  },
  RESULT
];

// Test 126 — **契約再記述禁止。** 渡すのは組み立て済みプロンプトそのもの。
//
// 「入力 == 送信内容」が成り立っていれば、CLAUDE.md や env の混入は executor 由来ではありえない
// （残る経路は CLI 側の設定読み込みで、そちらは --setting-sources "" が塞ぐ）。
test("126: the executor ships the assembled prompt verbatim on stdin, adding nothing", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];
  const { launch, captured } = fakeClaude(OK_EVENTS);

  const result = await createClaudeExecutor({ launch }).execute({ root, config, step, projectRoot: root });

  const expected = assembleStepPrompt(root, "improve-check", step).text;
  assert.equal(captured.stdin, expected, "1文字も足さない / 削らない");
  assert.equal(
    captured.argv.some((a) => a.includes("# ") && a.length > 200),
    false,
    "argv へ本文を載せない（stdin で渡す）"
  );

  // 送った本文の指紋を meta に残す（故障注入 #6 の照合材料）
  const { createHash } = await import("node:crypto");
  assert.equal((result.meta as any).promptSha256, createHash("sha256").update(expected).digest("hex"));

  // shell を経由しないための絶対パス起動（KI-08）
  assert.match(claudeEntrypoint(), /claude-code[\\/]bin[\\/]claude(\.exe)?$/);
});

// Test 127 — **生 session ID を残さない。** meta にも onProgress にも出ない。
//
// ⚠️ codex（thread.started のみ）と違い、claude は **init・全メッセージ・result** に
// session_id を載せる（§3 観測6）。捕まえ方も「最初に見た session_id」に変えてある。
test("127: the raw session id never reaches meta or the progress stream", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];
  const { launch } = fakeClaude([
    INIT,
    {
      type: "assistant",
      session_id: SESSION_ID,
      error: "authentication_failed",
      is_api_error_message: true,
      message: { content: [{ type: "text", text: `Not logged in (session ${SESSION_ID})` }] }
    },
    { ...RESULT, is_error: true, result: `Not logged in ${SESSION_ID}` }
  ]);
  const seen: ExecutorProgress[] = [];

  const result = await createClaudeExecutor({ launch }).execute({
    root,
    config,
    step,
    projectRoot: root,
    onProgress: (e) => seen.push(e)
  });

  const metaJson = JSON.stringify(result.meta);
  assert.equal(metaJson.includes(SESSION_ID), false, "meta に生 ID が混ざってはいけない");
  assert.match(metaJson, /"hash":"sha256:[0-9a-f]{64}"/, "hash では残す（照合できること）");
  assert.match(metaJson, /"tail":"5e6f"/);

  const shown = seen.map((e) => e.text).join("\n");
  assert.equal(shown.includes(SESSION_ID), false, "表示経路にも出さない");
  assert.match(shown, /<session:5e6f>/, "本文に紛れた分は伏せて出す");
  assert.equal(String(result.error).includes(SESSION_ID), false, "人間向けメッセージにも出さない");

  // ⚠️ 境界: **claude が吐く生 JSONL には session_id が入っている。**
  // それを runs/ へそのまま保存するのは許容（一次資料）。防衛対象は aiw が転記・要約する側。
  const jsonl = readFileSync(path.join(rootPaths(root).root, String((result.meta as any).jsonl)), "utf8");
  assert.equal(jsonl.includes(SESSION_ID), true, "生 JSONL は一次資料なのでそのまま保存する");
});

// Test 128 — **exit 0 / is_error:false は成功ではない。** executor は成果物を検証しない。
//
// 実測（§9-2）: permission 拒否で 1 文字も書けなかった実行が `is_error:false` / exit 0 で返った。
// codex の C-3（read-only 拒否でも exit 0）と同じ性質が Claude でも成立する。
test("128: exit 0 reports process completion only, never artifact success", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];
  const { launch } = fakeClaude([
    INIT,
    {
      type: "assistant",
      session_id: SESSION_ID,
      message: { content: [{ type: "text", text: "I could not edit the file." }] }
    },
    {
      ...RESULT,
      permission_denials: [{ tool_name: "Edit", tool_input: { file_path: "C:\\repo\\src\\Grid.tsx" } }]
    }
  ]);
  const seen: ExecutorProgress[] = [];

  const result = await createClaudeExecutor({ launch }).execute({
    root,
    config,
    step,
    projectRoot: root,
    onProgress: (e) => seen.push(e)
  });

  assert.equal(result.ok, true, "プロセスは完走している");
  assert.deepEqual(result.outputs, [], "executor は成果物を主張しない");
  assert.equal(result.failureKind, undefined);
  // ⚠️ **拒否を黙らせない。** meta にも表示にも残る（成果物が無いことの halt は file-exists の仕事）。
  assert.deepEqual((result.meta as any).permissionDenials, { count: 1, tools: ["Edit"] });
  assert.ok(
    seen.some((e) => e.kind === "error" && e.text === "denied: Edit"),
    "拒否は既定の表示でも出す"
  );
});

// Test 129 — 中断は transient。**failed に化けない**（KI-08 の二重判定）。
//
// ⚠️ executor は**タイマーを持たない**。総上限・無進行の見張りは engine/watchdog.ts。
// ここで見るのは「signal が撃たれたら子を殺し、transient として返す」配線だけ。
test("129: an aborted run kills the child and is transient, not a permanent failure", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];
  const { launch, captured } = fakeClaude([INIT], { hang: true });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  const result = await createClaudeExecutor({ launch }).execute({
    root,
    config,
    step,
    projectRoot: root,
    signal: controller.signal,
    timeoutMs: 60_000
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "transient", "再試行に意味がある種類として分類する");
  assert.equal((result.meta as any).timedOut, true);
  assert.ok(captured.killed >= 1, "子プロセスを止める");
});

// Test 130 — 隔離 CLAUDE_CONFIG_DIR が無ければ permanent で止める。
//
// 黙って ~/.claude へフォールバックしない。ユーザーの設定・skills・認証が混入する。
test("130: a missing isolated CLAUDE_CONFIG_DIR fails permanently instead of falling back", async () => {
  const { root, config } = makeRoot(); // .claude-home を作らない
  const step = config.steps["improve-check"];
  const { launch, captured } = fakeClaude(OK_EVENTS);

  const result = await createClaudeExecutor({ launch }).execute({ root, config, step, projectRoot: root });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "permanent");
  assert.match(result.error ?? "", /claude auth login/);
  assert.deepEqual(captured.argv, [], "起動そのものをしない");
});

// Test 131 — **ツール制限は宣言から導く**（設計 課題B）。
//
//   - `Write` は `--tools` に入れない（`Write(path)` のパスルールは監視されない・§9-2 実測）
//   - `Edit` の許可は **steps.<id>.outputs の列挙**。`runtimeRoot/**` にしない
//     （state.json / runs/ / config/ まで編集できると、エージェントがハーネス自身を書き換えられる）
//   - `Bash` は許可コマンドを宣言したステップにだけ渡す
//   - パスは POSIX 絶対（`//c/…`）。バックスラッシュ絶対パスは効かない（§9-2 実測）
test("131: tool limits come from the step's declarations, and Write is never offered", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];

  assert.equal(toolSet(step), "Read,Grep,Glob,Edit", "宣言に Bash が無ければ Bash は渡らない");
  const withBash: WorkflowStep = { ...step, bashAllow: ["git diff:*", "git status:*"] };
  assert.equal(toolSet(withBash), "Read,Grep,Glob,Bash,Edit");

  const rules = allowRules(root, withBash);
  assert.deepEqual(rules.slice(0, 3), ["Read", "Grep", "Glob"], "読み取りは無条件");
  assert.deepEqual(
    rules.filter((r) => r.startsWith("Bash(")),
    ["Bash(git diff:*)", "Bash(git status:*)"]
  );
  const edits = rules.filter((r) => r.startsWith("Edit("));
  assert.equal(edits.length, 1, "improve-check の出力は current-status.json 1 本だけ");
  // ⚠️ 照合は文字列比較なので **OS の正式表記へ直してから**渡す。
  // 実測（2026-09-04 のスモーク）: Windows の 8.3 短縮名（`TOMO~1.SAK`）のまま渡すと
  // Claude 側が解決した長い名前と一致せず、**Edit が拒否された**。
  // 気付けなければ「書けないのに exit 0」で終わる形だった。
  const realRoot = realpathSync.native(root);
  assert.equal(edits[0], `Edit(${toPosixAbsolute(path.join(realRoot, "current-status.json"))})`);
  assert.equal(edits[0].includes("~"), false, "8.3 短縮名のまま渡さない");
  assert.match(edits[0], /^Edit\(\/\/[a-z]\/.*current-status\.json\)$/, "POSIX 絶対（//c/…）で渡す");
  assert.equal(edits[0].includes("\\"), false, "バックスラッシュを含めない");
  assert.equal(edits[0].includes("**"), false, "ディレクトリ丸ごとの許可にしない");

  // 実際の argv でも同じものが渡ること
  const { launch, captured } = fakeClaude(OK_EVENTS);
  await createClaudeExecutor({ launch }).execute({ root, config, step, projectRoot: root });
  const argv = captured.argv;
  assert.equal(argv[argv.indexOf("--tools") + 1], "Read,Grep,Glob,Edit");
  assert.equal(argv.includes("Write"), false, "Write はツールとしても許可としても渡さない");
  assert.equal(
    argv.some((a) => a.startsWith("Write(")),
    false
  );
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "dontAsk", "未許可は問い合わせず自動拒否");
});

// Test 132 — **暗黙の入力の遮断**（設計 課題D）。フラグ一式と env の許可リスト。
test("132: implicit inputs are cut off by flags and an env allowlist", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];
  const { launch, captured } = fakeClaude(OK_EVENTS);

  await createClaudeExecutor({ launch }).execute({ root, config, step, projectRoot: root });

  const argv = captured.argv;
  // プロジェクト CLAUDE.md / settings.json の遮断（空文字が「どのソースも読まない」）
  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "", "--setting-sources \"\" を渡す");
  assert.ok(argv.includes("--strict-mcp-config"), "MCP の混入を遮断");
  assert.ok(argv.includes("--disable-slash-commands"), "同梱 skills の保険");
  assert.ok(argv.includes("--no-session-persistence"), "transcript を残さない（fresh 固定）");
  assert.ok(argv.includes("-p") && argv.includes("--verbose"), "非対話 + stream-json");

  // env は**許可リスト**。親セッションの変数を子へ渡さない。
  const env = claudeEnv(
    {
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      ANTHROPIC_BASE_URL: "https://leak.example",
      ANTHROPIC_API_KEY: "sk-leak",
      CLAUDECODE: "1",
      CLAUDE_EFFORT: "high",
      SOME_FUTURE_SECRET: "x"
    },
    "/iso/home"
  );
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "PATH", "SystemRoot"]);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/iso/home");
  assert.equal(env.DISABLE_AUTOUPDATER, "1", "pin を自動更新に壊させない（2026-09-01 実測の対策）");
  // ⚠️ 知らない変数名（SOME_FUTURE_SECRET）が落ちることが、拒否リストではなく
  // 許可リストにした理由そのもの。
  assert.equal(env.SOME_FUTURE_SECRET, undefined);

  // 実際に子へ渡した env も同じ形（CLAUDE_CONFIG_DIR は隔離 home を指す）
  assert.equal(captured.env.CLAUDE_CONFIG_DIR, path.resolve(root, ".claude-home"));
  assert.equal(captured.env.ANTHROPIC_BASE_URL, undefined);
});

// Test 133 — model / effort の解決と記録。
//
// ⚠️ **model は実測できるが effort はできない**（§8）。名前でその非対称を持たせる:
// modelRequested / modelObserved の対に対し、effort は effortRequested だけ。
test("133: model and effort resolve step > settings, and are recorded as requested vs observed", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];
  const settings = { ...config.settings, claudeModel: "claude-opus-5", claudeEffort: "low" };

  // settings の既定が掛かる
  const a = fakeClaude(OK_EVENTS);
  const base = await createClaudeExecutor({ launch: a.launch }).execute({
    root,
    config: { ...config, settings },
    step,
    projectRoot: root
  });
  assert.equal(a.captured.argv[a.captured.argv.indexOf("--model") + 1], "claude-opus-5");
  assert.equal(a.captured.argv[a.captured.argv.indexOf("--effort") + 1], "low");
  assert.equal((base.meta as any).modelRequested, "claude-opus-5");
  assert.equal((base.meta as any).effortRequested, "low");
  assert.deepEqual(
    (base.meta as any).modelObserved,
    ["claude-haiku-4-5-20251001", "claude-opus-5"],
    "実測は複数キーになる（補助モデルが併用される・§9-4）"
  );

  // step の宣言が settings に勝つ
  const b = fakeClaude(OK_EVENTS);
  const overridden = await createClaudeExecutor({ launch: b.launch }).execute({
    root,
    config: { ...config, settings },
    step: { ...step, model: "claude-sonnet-5", effort: "high" },
    projectRoot: root
  });
  assert.equal(b.captured.argv[b.captured.argv.indexOf("--model") + 1], "claude-sonnet-5");
  assert.equal(b.captured.argv[b.captured.argv.indexOf("--effort") + 1], "high");
  assert.equal((overridden.meta as any).effortRequested, "high");

  // 未指定は渡さない。ただし **"unspecified" と明示記録する**
  const c = fakeClaude(OK_EVENTS);
  const bare = await createClaudeExecutor({ launch: c.launch }).execute({ root, config, step, projectRoot: root });
  assert.equal(c.captured.argv.includes("--model"), false);
  assert.equal(c.captured.argv.includes("--effort"), false);
  assert.equal((bare.meta as any).modelRequested, "unspecified");
  assert.equal(
    (bare.meta as any).effortRequested,
    "unspecified",
    "null や欠落にしない（「未指定と記録した」と「記録が無い」を区別する）"
  );
});

// Test 134 — usage / modelUsage / denials の写し取り。
test("134: usage maps onto the Event Log token fields; unmeasurable values stay null", () => {
  const u = usageFrom(RESULT);
  assert.deepEqual(u, {
    inputTokens: 4212,
    outputTokens: 318,
    cacheReadTokens: 39561,
    cacheWriteTokens: 1204,
    // claude の result に reasoning の内訳は無い。0 に丸めない
    reasoningTokens: null
  });
  assert.equal(usageFrom({ type: "assistant", usage: { input_tokens: 1 } }), null, "result 以外から読まない");
  assert.equal(usageFrom({ type: "result" }), null);

  assert.deepEqual(modelsObserved(RESULT), ["claude-haiku-4-5-20251001", "claude-opus-5"]);
  assert.equal(modelsObserved({ modelUsage: {} }), null, "空を「観測できた」にしない");
  assert.equal(modelsObserved({}), null);

  assert.equal(denialSummary(RESULT), null, "拒否ゼロは null（0 件を「記録あり」にしない）");
  assert.deepEqual(
    denialSummary({ permission_denials: [{ tool_name: "Edit" }, { tool_name: "Edit" }, { tool_name: "Bash" }] }),
    { count: 3, tools: ["Bash", "Edit"] },
    "件数は潰さず、ツール名は重複を畳む"
  );
});

// Test 135 — 失敗の分類（設計 課題F）。**成功判定には使わない。**
//
// ⚠️ `result.subtype` は認証失敗でも "success" を返す（§3 観測5）。正は `is_error`。
test("135: failures classify from the observed events, not from subtype", async () => {
  assert.equal(classifyFailure({ apiErrorStatus: 401, text: "" }), "permanent");
  assert.equal(classifyFailure({ apiErrorStatus: 403, text: "" }), "permanent");
  assert.equal(classifyFailure({ apiErrorStatus: 429, text: "" }), "transient");
  assert.equal(classifyFailure({ apiErrorStatus: 503, text: "" }), "transient");
  assert.equal(classifyFailure({ subtype: "error_max_turns", text: "" }), "permanent");
  assert.equal(classifyFailure({ subtype: "error_max_budget_usd", text: "" }), "permanent");
  assert.equal(classifyFailure({ text: "Not logged in · Please run /login" }), "permanent");
  assert.equal(classifyFailure({ text: "overloaded_error" }), "transient");
  // 分からないものは transient（言い切れない失敗を人間送りにすると無人運転が止まる）
  assert.equal(classifyFailure({ text: "something new" }), "transient");

  // 実行経路でも: subtype が "success" のまま is_error だけが true という形を落とす
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];
  const { launch } = fakeClaude(
    [INIT, { ...RESULT, subtype: "success", is_error: true, result: "Not logged in · Please run /login" }],
    { code: 1 }
  );
  const result = await createClaudeExecutor({ launch }).execute({ root, config, step, projectRoot: root });

  assert.equal(result.ok, false, "subtype:success に騙されない");
  assert.equal(result.failureKind, "permanent", "資格情報は再試行で解けない");
  assert.match(result.error ?? "", /Not logged in/);
});

// Test 136 — **再実行可能性（防衛線1）。** executor は実行間で何も引き継がない。
//
// 1回目を中断しても、2回目は入力成果物ファイルだけから同じプロンプトを組み立てて走る。
// あわせて **executor が state.json を触らない**ことも見る（責務の分離・不変条件1）。
test("136: a killed run leaves no carry-over; the retry starts fresh from the artifact files", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];
  const stateBefore = statSync(rootPaths(root).stateFile);

  const first = fakeClaude([INIT], { hang: true });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const killed = await createClaudeExecutor({ launch: first.launch }).execute({
    root,
    config,
    step,
    projectRoot: root,
    signal: controller.signal,
    timeoutMs: 60_000
  });
  assert.equal(killed.ok, false);

  const second = fakeClaude(OK_EVENTS);
  const redone = await createClaudeExecutor({ launch: second.launch }).execute({ root, config, step, projectRoot: root });

  assert.equal(redone.ok, true, "2回目は完走する");
  assert.equal(second.captured.stdin, first.captured.stdin, "同じ入力から同じプロンプトが出る");
  assert.equal(
    second.captured.argv.some((a) => a.includes("--resume") || a.includes("--continue") || a.includes("--session-id")),
    false,
    "セッションを引き継ぐ引数を渡さない（fresh 固定）"
  );
  assert.deepEqual(
    statSync(rootPaths(root).stateFile).mtimeMs,
    stateBefore.mtimeMs,
    "executor は state.json を触らない"
  );
});

// Test 137 — 表示は種別と対象の要約のみ。全文を流さない。
//
// ⚠️ codex 版と違い**配列を返す**: assistant の1メッセージは text と tool_use を同時に運び、
// result は tokens と拒否を同時に運ぶ。1行へ潰すと拒否が消える。
test("137: progress lines summarize each event without streaming its content", () => {
  const long = "x".repeat(500);
  const assistant = summarize(
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "…" },
          { type: "text", text: long },
          { type: "tool_use", name: "Edit", input: { file_path: "C:/x/.ai-workflow/current-status.json" } },
          { type: "tool_use", name: "Bash", input: { command: "git diff --stat\ngit log" } },
          { type: "tool_use", name: "Read", input: { file_path: "C:/x/current-review.md" } }
        ]
      }
    },
    null
  );
  assert.deepEqual(
    assistant.map((e) => e.kind),
    ["thinking", "message", "edit", "shell", "thinking"]
  );
  assert.ok(assistant[1].text.length <= 240, `全文を流さない（実際 ${assistant[1].text.length}）`);
  assert.equal(assistant[2].text, "edit: current-status.json");
  assert.equal(assistant[3].text, "shell: git diff --stat", "コマンドは1行目のみ");

  // 複数行の発言は1行へ畳む（画面が縦に流れないように）
  const folded = summarize(
    { type: "assistant", message: { content: [{ type: "text", text: "一行目\n\n二行目   三行目" }] } },
    null
  );
  assert.equal(folded[0].text, "一行目 二行目 三行目");

  const done = summarize(RESULT, null);
  assert.deepEqual(done, [{ kind: "tokens", text: "tokens: in 4.2K / out 318 / cacheRead 39.6K" }]);

  // ツール結果（user イベント）は画面に出さない
  assert.deepEqual(summarize({ type: "user", message: { content: [{ type: "tool_result" }] } }, null), []);
});

// Test 159 — **読んだ形跡を記録する**（M4 段階1-3）。判定には使わない。
//
// 知識ファイルを「全文結合」から「目次 + 必要な節を読む」へ移すと、読み漏れは
// 記録からしか分からない。⚠️ ポインタ方式は実測で **5 周中 4 周（= 1/5 の不発）**。
// 目次に条件付き必読を書いたうえで、最後の観測点としてここに残す。
test("159: the executor records which files were read, as an observation and never as a verdict", async () => {
  const { root, config } = readyRoot();
  const step = config.steps["improve-check"];
  const { launch } = fakeClaude([
    INIT,
    {
      type: "assistant",
      session_id: SESSION_ID,
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "C:/x/.ai-workflow/context.md" } },
          { type: "tool_use", name: "Read", input: { file_path: "C:/x/.ai-workflow/instructions/local-environment-detail.md" } },
          { type: "tool_use", name: "Read", input: { file_path: "C:/x/.ai-workflow/context.md" } },
          { type: "tool_use", name: "Grep", input: { pattern: "x" } },
          { type: "tool_use", name: "Edit", input: { file_path: "C:/x/.ai-workflow/current-status.json" } }
        ]
      }
    },
    RESULT
  ]);

  const result = await createClaudeExecutor({ launch }).execute({ root, config, step, projectRoot: root });

  assert.deepEqual(
    (result.meta as any).filesRead,
    ["context.md", "local-environment-detail.md"],
    "basename で重複を畳む（全文は runs/ の JSONL にある）"
  );
  // ⚠️ **判定は変えない。** 読んでいようがいまいが ok / failureKind は成果物の話ではない
  assert.equal(result.ok, true);
  assert.equal(result.failureKind, undefined);

  // Read 以外のツールは拾わない（Edit した先を「読んだ」に混ぜない）
  assert.equal((result.meta as any).filesRead.includes("current-status.json"), false);

  // 1 件も読まなければ空配列。**null にしない**（「読まなかった」は観測できている）
  const quiet = fakeClaude(OK_EVENTS);
  const none = await createClaudeExecutor({ launch: quiet.launch }).execute({ root, config, step, projectRoot: root });
  assert.deepEqual((none.meta as any).filesRead, []);
});
