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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execStep, loadConfig, runStep } from "../src/engine/engine.js";
import { createCodexExecutor } from "../src/engine/executors/codex.js";
import { clipboardExecutor } from "../src/engine/executors/clipboard.js";
import { rootPaths } from "../src/engine/paths.js";
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
