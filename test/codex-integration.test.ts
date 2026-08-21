// codex executor の統合面（M3 段階1-1 の(3)）。
//
// 個々の性質は codex-executor.test.ts が見る。ここで見るのは
// **エンジンと繋いだときに何が Event Log へ残るか / 残らないか**。
//
// 故障注入リスト（設計文書 課題G）のうち、ここで固定するもの:
//   #1 実行途中で kill → 成果物ファイルだけから fresh 再実行で完走
//   #3 exit 0 でゴミ → executor は成功を報告し、判定は validator に委ねる
//   #5 生 ID grep
//   #6 clipboard へ戻して従来動作（ロールバック）
//   #9 exit 0 + 成果物なし → file-exists が halt し、executor は成功を主張しない
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execStep, loadConfig, runStep } from "../src/engine/engine.js";
import { createCodexExecutor } from "../src/engine/executors/codex.js";
import { clipboardExecutor } from "../src/engine/executors/clipboard.js";
import { getExecutor } from "../src/engine/executors/index.js";
import { rootPaths } from "../src/engine/paths.js";
import { defaultPostActions } from "../src/engine/postActions.js";
import { DEFAULT_ENGINE_STATE } from "../src/engine/types.js";
const archiveArtifacts = defaultPostActions.archiveArtifacts;
import { makeRoot, setStep } from "./helpers.js";

const THREAD_ID = "01a013b1-80e9-7c71-9460-305caf414464";

function events(extra: unknown[] = []) {
  return [
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "turn.started" },
    ...extra,
    {
      type: "turn.completed",
      usage: { input_tokens: 26539, cached_input_tokens: 13056, cache_write_input_tokens: 0, output_tokens: 109, reasoning_output_tokens: 42 }
    }
  ];
}

/** stdout へ JSONL を流して閉じる偽 codex。`onStdin` で成果物の生成を模す。 */
function fake(lines: unknown[], onStdin?: () => void, code = 0) {
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
      stdout.end();
      handlers.close?.(code, null);
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
  mkdirSync(path.join(root, ".codex-home"), { recursive: true });
  setStep(root, "implementation");
  return { root, config };
}

/** `fake` と同じだが、渡された argv を覗ける版（起動引数を検査したいテスト用）。 */
function fakeCaptured(lines: unknown[]) {
  const captured = { argv: [] as string[] };
  const base = fake(lines);
  const launch = (argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
    captured.argv = argv;
    return (base.launch as any)(argv, o);
  };
  return { launch, captured, state: base.state };
}

function lastEvent(root: string, type: string): any {
  const lines = readFileSync(rootPaths(root).eventLog, "utf8").trim().split("\n").filter(Boolean);
  const hit = lines.map((l) => JSON.parse(l)).filter((r) => r.event === type);
  return hit[hit.length - 1];
}

// Test 100 — **トークンが Event Log へ載る（B-4）。** 「全件 null」がここで解消する。
test("100: exec.completed carries the token usage codex reported", async () => {
  const { root, config } = ready();
  const { launch } = fake(events());

  await execStep(root, config, "implementation", { executor: createCodexExecutor({ launch }) });

  const ev = lastEvent(root, "exec.completed");
  assert.equal(ev.inputTokens, 26539);
  assert.equal(ev.outputTokens, 109);
  assert.equal(ev.cacheReadTokens, 13056, "§2 のキャッシュ判定に使う値");
  assert.equal(ev.cacheWriteTokens, 0);
  assert.equal(ev.reasoningTokens, 42);
});

// Test 101 — トークンを測れない executor では **null のまま**（0 に丸めない）。
test("101: an executor that reports no usage leaves the token fields null", async () => {
  const { root, config } = ready();

  await execStep(root, config, "implementation", { executor: clipboardExecutor });

  const ev = lastEvent(root, "exec.completed");
  assert.equal(ev.inputTokens, null, "測れなかったを 0 と混ぜない");
  assert.equal(ev.outputTokens, null);
  assert.equal(ev.cacheReadTokens, null);
});

// Test 102 — **故障注入 #5: 生 ID grep。** Event Log 全文に生 session ID が出ない。
//
// ⚠️ 境界: codex が吐く **生 JSONL（runs/codex/）には thread_id が入っている**。
// それは一次資料なのでそのまま保存してよい。防衛対象は **aiw が転記・要約する側**、
// すなわち Event Log と表示経路。この線引きを崩さないこと。
test("102: the raw session id never appears in the Event Log", async () => {
  const { root, config } = ready();
  const { launch } = fake(events([{ type: "error", message: `flaky ${THREAD_ID}` }]));
  const shown: string[] = [];

  await execStep(root, config, "implementation", {
    executor: createCodexExecutor({ launch }),
    onProgress: (e) => shown.push(e.text)
  });

  const log = readFileSync(rootPaths(root).eventLog, "utf8");
  assert.equal(log.includes(THREAD_ID), false, "Event Log に生 ID があってはいけない");
  assert.match(log, /sha256:[0-9a-f]{64}/, "hash では残っている");
  assert.equal(shown.join("\n").includes(THREAD_ID), false, "表示経路にも出ない");

  const ev = lastEvent(root, "exec.completed");
  const jsonl = readFileSync(path.join(root, ev.meta.jsonl), "utf8");
  assert.equal(jsonl.includes(THREAD_ID), true, "一次資料は runs/ に隔離して保存する");
});

// Test 103 — **故障注入 #9: exit 0 + 成果物なし。**
// executor は成功を主張せず（outputs 空）、file-exists が halt する。
test("103: exit 0 with no artifact still halts at file-exists", async () => {
  const { root, config } = ready();
  const { launch } = fake(events()); // 何も書かない
  rmSync(path.join(root, "current-result.md"), { force: true });

  const result = await execStep(root, config, "implementation", { executor: createCodexExecutor({ launch }) });
  assert.equal(result.ok, true, "プロセスは完走している");
  assert.deepEqual(result.outputs, [], "executor は成果物を主張しない");

  const outcome = runStep(root, config, "implementation");
  assert.equal(outcome.kind, "halted", "判定は validator の仕事");
  assert.match(String((outcome as any).message ?? ""), /current-result\.md/);
});

// Test 104 — **故障注入 #1: 再実行可能性。**
// 1回目を kill → 成果物ファイルだけから fresh 再実行して完走する。
//
// 会話履歴やセッションでステップを繋いでいると、この経路は通らない。
test("104: a killed run can be redone from the artifact files alone", async () => {
  const { root, config } = ready();

  // 1回目: 何も書かずに kill される
  const killed = createCodexExecutor({
    launch: () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const handlers: { close?: (c: number | null, s: NodeJS.Signals | null) => void } = {};
      stdin.on("finish", () => {
        stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: THREAD_ID })}\n`);
        handlers.close?.(null, "SIGTERM" as NodeJS.Signals);
      });
      return {
        stdin,
        stdout,
        stderr: new PassThrough(),
        kill: () => handlers.close?.(null, "SIGTERM" as NodeJS.Signals),
        on(event: string, cb: any) {
          if (event === "close") handlers.close = cb;
        }
      };
    }
  });
  const first = await execStep(root, config, "implementation", { executor: killed });
  assert.equal(first.ok, false);
  assert.equal(first.failureKind, "transient", "中断は再試行に意味がある種類");

  // 2回目: セッションを引き継がず（fresh）、入力成果物だけで完走する
  const { launch, state } = fake(events(), () => {
    writeFileSync(path.join(root, "current-result.md"), "# Summary\n\nredone from files\n", "utf8");
  });
  const second = await execStep(root, config, "implementation", { executor: createCodexExecutor({ launch }) });

  assert.equal(second.ok, true);
  assert.equal(state.launches, 1, "新しいプロセスを起こしている");
  assert.equal((second.meta as any).session.hash, (first.meta as any).session?.hash ?? null, "同じ入力なら同じ hash（引き継ぎではなく偶然の一致）");
  assert.match(readFileSync(path.join(root, "current-result.md"), "utf8"), /redone from files/);
});

// Test 105 — **故障注入 #6: ロールバック。** executor を clipboard へ戻せば従来動作。
test("105: switching the executor back to clipboard restores the previous behaviour", async () => {
  const { root } = ready();
  const { workflowYaml } = rootPaths(root);
  const raw = readFileSync(workflowYaml, "utf8");

  // codex を宣言 → 隔離 home を消して permanent 失敗にする
  writeFileSync(
    workflowYaml,
    raw.replace("  implementation:\n    role: codex", "  implementation:\n    role: codex\n    executor: codex"),
    "utf8"
  );
  rmSync(path.join(root, ".codex-home"), { recursive: true, force: true });
  const broken = await execStep(root, loadConfig(root), "implementation");
  assert.equal(broken.ok, false);
  assert.equal(broken.failureKind, "permanent");

  // clipboard へ戻す（宣言を消すと既定が clipboard）
  writeFileSync(workflowYaml, raw, "utf8");
  const config = loadConfig(root);
  assert.equal(config.steps["implementation"].executor, "clipboard");

  const written: string[] = [];
  const restored = await execStep(root, config, "implementation", {
    executor: (await import("../src/engine/executors/clipboard.js")).createClipboardExecutor({
      write: async (t) => void written.push(t)
    })
  });
  assert.equal(restored.ok, true, "従来動作へ復帰する");
  assert.equal(written.length, 1);
});

// Test 106 — **drive も executor 宣言を解決する（M3 段階1）。**
//
// 段階2 では「宣言は効きません」と警告するだけだったが、実タスク検証が済んだので
// drive 自身が executor を起動するようにした（driveExecutorNotice は役目を終えて削除）。
//
// drive は対話ループなのでループ本体は動かせない。ここで固定するのは
// **宣言と実体の一致**——`getExecutor` が宣言どおりの executor を返すこと。
// 「宣言したのに別物が動く」を防ぐのがこのテストの目的。
test("106: a declared executor resolves to that executor, so drive runs what the config says", () => {
  const { root } = makeRoot();
  const { workflowYaml } = rootPaths(root);
  const raw = readFileSync(workflowYaml, "utf8");

  writeFileSync(
    workflowYaml,
    raw.replace("  implementation:\n    role: codex", "  implementation:\n    role: codex\n    executor: codex"),
    "utf8"
  );
  const declared = loadConfig(root).steps["implementation"];
  assert.equal(declared.executor, "codex");
  assert.equal(getExecutor(declared.executor).name, "codex", "宣言どおりの executor が返る");

  // 宣言を外せば既定の clipboard（drive は従来動作へ戻る = 不変条件5）
  writeFileSync(workflowYaml, raw, "utf8");
  const bare = loadConfig(root).steps["implementation"];
  assert.equal(bare.executor, "clipboard");
  assert.equal(getExecutor(bare.executor).name, "clipboard");
});

// Test 114 — **故障注入 #7: 認証切れ。** permanent として記録し、再試行に回さない。
//
// 実測（2026-08-18）: 空の CODEX_HOME では 401 Unauthorized で exit 1。
// codex 自身が 5 回リトライしてから落ちるので、**aiw 側で再試行しても同じ結果**になる。
// transient と誤分類すると、M5 の consecutiveExecFailures が無駄な再試行を重ねる。
test("114: an expired credential is permanent, so the engine will not retry it", async () => {
  const { root, config } = ready();
  const { launch } = fake(
    [
      { type: "thread.started", thread_id: THREAD_ID },
      { type: "error", message: "Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer)" }
    ],
    undefined,
    1
  );

  const result = await execStep(root, config, "implementation", { executor: createCodexExecutor({ launch }) });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "permanent", "401 は再試行しても直らない");
  assert.match(result.error ?? "", /401|Unauthorized/i);

  const ev = lastEvent(root, "exec.failed");
  assert.equal(ev.failureKind, "permanent", "Event Log にも種別が残る（M5 が読む）");
});

// Test 115 — **故障注入 #8: runtimeRoot が checkRepoRoot の外。**
// 起動せずに止める。**黙って書けない状態で走らせない。**
//
// codex は -C の配下しか書けない（workspace-write の実測）。runtimeRoot が外にあると
// current-result.md を書けずに終わり、exit 0 で「何もしなかった」が返る（C-3 の形）。
//
// ⚠️ **設計文書の課題G #8 は「起動せずに停止」と書いていたが、これは A-2 の要約を誤っていた。**
// A-2 の本文は「外なら `--add-dir <runtimeRoot>` を足す。**判定できないときだけ**起動しない」。
// 実装は A-2 に従っている。#8 の行は実装に合わせて訂正した。
test("115: a runtime root outside the workspace is rescued with --add-dir, and an unresolvable one does not launch", async () => {
  const { root, config } = ready();

  // (a) 通常: runtimeRoot が -C の配下 → --add-dir は要らない
  const inside = fakeCaptured(events());
  await createCodexExecutor({ launch: inside.launch }).execute({
    root,
    config,
    step: config.steps["implementation"],
    projectRoot: root
  });
  assert.equal(inside.captured.argv.includes("--add-dir"), false, "配下なら足さない（実測で不要）");

  // (b) 外: --add-dir で runtimeRoot を救済する。**黙って書けない状態で走らせない**
  //
  // ⚠️ 「外」は**兄弟**でなければならない。祖先（root/../..）を渡すと runtimeRoot は
  // その配下に入ってしまい、救済の経路を通らない（最初この前提を間違えてテストが落ちた）。
  const sibling = path.resolve(root, "..", "elsewhere-workspace");
  mkdirSync(sibling, { recursive: true });
  const outside = fakeCaptured(events());
  const rescued = await createCodexExecutor({ launch: outside.launch }).execute({
    root,
    config,
    step: config.steps["implementation"],
    projectRoot: sibling
  });
  assert.equal(rescued.ok, true);
  const i = outside.captured.argv.indexOf("--add-dir");
  assert.ok(i > 0, "外にあるなら --add-dir を足す");
  assert.equal(path.resolve(outside.captured.argv[i + 1]), path.resolve(root), "救済する先は runtimeRoot");
  assert.equal((rescued.meta as any).addDir !== null, true, "救済したことが meta に残る");

  // (c) checkRepoRoot を解決できない → **起動しない**（permanent）
  const broken = fakeCaptured(events());
  const failed = await createCodexExecutor({ launch: broken.launch }).execute({
    root,
    config: { ...config, settings: { ...config.settings, repoRoot: "no/such/dir" } },
    step: config.steps["implementation"]
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.failureKind, "permanent");
  assert.deepEqual(broken.captured.argv, [], "解決できないときは起動そのものをしない");
});

// Test 116 — **B2: このタスクの codex JSONL が archive へ随伴する。**
//
// 目的は M7 の追跡（一回の失敗を後から追える）。成果物だけが archive にあっても、
// **その実装が何をしたか**は JSONL にしか無い。記録が 2 箇所に分かれると照合できない。
//
// ⚠️ copy であって move ではない（runs/ は残す。aiw log が読む先だから）。
// ⚠️ どれが今回の分かは **Event Log のタスク窓**から決める。mtime の推測に頼らない。
test("116: this task's codex runs travel with the archive, and runs/ is left intact", async () => {
  const { root, config } = ready();
  const { launch } = fake(events(), () => {
    writeFileSync(path.join(root, "current-result.md"), "# Summary\n\ndone\n", "utf8");
  });

  const result = await execStep(root, config, "implementation", { executor: createCodexExecutor({ launch }) });
  const jsonlRel = String((result.meta as any).jsonl);

  archiveArtifacts({
    root,
    config,
    step: config.steps["reflection"],
    status: { step: "reflection", result: "feature-complete", reason: "t" } as any,
    result: "feature-complete",
    draft: { ...DEFAULT_ENGINE_STATE, currentStep: "reflection" } as any
  });

  const dirs = readdirSync(path.join(rootPaths(root).archiveDir, "single"));
  assert.equal(dirs.length, 1);
  const runsDir = path.join(rootPaths(root).archiveDir, "single", dirs[0], "runs");
  assert.ok(existsSync(runsDir), "archive に runs/ が作られる");
  assert.ok(
    readdirSync(runsDir).some((f) => f === path.basename(jsonlRel)),
    "この実行の JSONL が随伴している"
  );
  assert.ok(existsSync(path.join(root, jsonlRel)), "**move ではない**。runs/ 側は残る（aiw log が読む）");
});

// Test 117 — clipboard だけで回したタスクでは JSONL が無い。**欠落ではなく正常。**
test("117: a clipboard-only task archives without a runs/ directory", () => {
  const { root, config } = ready();

  archiveArtifacts({
    root,
    config,
    step: config.steps["reflection"],
    status: { step: "reflection", result: "feature-complete", reason: "t" } as any,
    result: "feature-complete",
    draft: { ...DEFAULT_ENGINE_STATE, currentStep: "reflection" } as any
  });

  const dirs = readdirSync(path.join(rootPaths(root).archiveDir, "single"));
  const runsDir = path.join(rootPaths(root).archiveDir, "single", dirs[0], "runs");
  assert.equal(existsSync(runsDir), false, "空の runs/ を作らない（無いことが正しい）");
});
