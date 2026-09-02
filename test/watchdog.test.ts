// 総上限 / 無進行の二段構え（engine/watchdog.ts + execStep の配線）。
//
// ⚠️ **実配置を模倣する**（new-artifact-checklist の9点目）: watchdog に時計や
// タイマーを注入せず、`workflow.yaml` の設定を短くして**本物のタイマー**で回す。
// 注入すると「テストの中でだけ動く見張り」になり、engine.ts の配線が抜けていても通る。
//
// 故障注入（このマイルストーンの完了条件）:
//   1 イベントを出し続けて総上限超過 → total で中断。**failed に誤判定しない**
//   2 イベントが途絶える → idle で中断。理由が total と区別されて残る
//   3 長い沈黙のあと閾値未満で再開 → 中断されない
//   4 steps.<id>.timeoutMs の上書きが効く
//   5 中断後、成果物ファイルだけから fresh 再実行で完走（M3 防衛線1 の再確認）
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execStep } from "../src/engine/engine.js";
import { readEventLog } from "../src/engine/observed.js";
import type { ExecutorRequest, ExecutorResult, StepExecutor } from "../src/engine/executors/types.js";
import { DEFAULT_TOTAL_TIMEOUT_MS, classifyTimeout, createWatchdog } from "../src/engine/watchdog.js";
import { makeRoot, setStep } from "./helpers.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 中断されるまでイベントを出し続ける fake executor。
 * **codex.ts と同じ契約**: signal が abort したら止め、ok:false / transient を返す。
 */
function pulsingExecutor(opts: { everyMs: number; silentAfter?: number; resumeAfterMs?: number }): {
  executor: StepExecutor;
  events: () => number;
} {
  let emitted = 0;
  const executor: StepExecutor = {
    name: "codex",
    async execute(req: ExecutorRequest): Promise<ExecutorResult> {
      const started = Date.now();
      while (!req.signal?.aborted) {
        const silent = opts.silentAfter !== undefined && emitted >= opts.silentAfter;
        const resumed = opts.resumeAfterMs !== undefined && Date.now() - started >= opts.resumeAfterMs;
        if (!silent || resumed) {
          emitted++;
          req.onProgress?.({ kind: "message", text: `tick ${emitted}` });
        }
        await sleep(opts.everyMs);
        if (Date.now() - started > 20_000) {
          break; // テストが暴走しない保険。ここに来たら watchdog が効いていない
        }
      }
      return {
        ok: false,
        outputs: [],
        error: "codex executor: タイムアウト",
        failureKind: "transient",
        meta: { executor: "codex" }
      };
    }
  };
  return { executor, events: () => emitted };
}

function configWith(base: ReturnType<typeof makeRoot>["config"], settings: Record<string, unknown>, step?: Record<string, unknown>) {
  return {
    ...base,
    settings: { ...base.settings, ...settings },
    steps: step ? { ...base.steps, implementation: { ...base.steps.implementation, ...step } } : base.steps
  };
}

function lastExecEvent(root: string): Record<string, unknown> | null {
  const log = readEventLog(root);
  if (log === "missing" || log === "unreadable") return null;
  const rows = log.filter((r) => /^exec\.(completed|failed)$/.test(String((r as { event?: string }).event)));
  return (rows[rows.length - 1] as Record<string, unknown>) ?? null;
}

// 故障注入 1
test("watchdog: a run that keeps emitting is stopped by the total cap, not misreported as failed", async () => {
  const { root, config: base } = makeRoot();
  setStep(root, "implementation");
  const config = configWith(base, { codexTimeoutMs: 400, codexIdleTimeoutMs: 10_000 });
  const { executor } = pulsingExecutor({ everyMs: 20 });

  const result = await execStep(root, config, "implementation", { executor });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "transient", "**permanent に誤分類しない**（再試行の可否が変わる）");
  assert.equal((result.meta as { timeoutKind?: string }).timeoutKind, "total");
  assert.match(result.error ?? "", /総上限タイムアウト/);

  const ev = lastExecEvent(root);
  assert.equal(ev?.event, "exec.failed");
  assert.equal((ev?.meta as { timeoutKind?: string })?.timeoutKind, "total", "Event Log にも種別が残る");
});

// 故障注入 2
test("watchdog: a stalled run is stopped by the idle timer and the reason is distinguishable", async () => {
  const { root, config: base } = makeRoot();
  setStep(root, "implementation");
  // 総上限は十分長く、無進行だけが撃つ状況にする
  const config = configWith(base, { codexTimeoutMs: 15_000, codexIdleTimeoutMs: 250 });
  const { executor, events } = pulsingExecutor({ everyMs: 20, silentAfter: 3 });

  const started = Date.now();
  const result = await execStep(root, config, "implementation", { executor });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal((result.meta as { timeoutKind?: string }).timeoutKind, "idle");
  assert.match(result.error ?? "", /無進行タイムアウト/);
  assert.doesNotMatch(result.error ?? "", /総上限/, "**2つの理由を1つに潰さない**");
  assert.ok(elapsed < 15_000, `総上限を待たずに中断する（実測 ${elapsed}ms）`);
  assert.ok(events() >= 3, "沈黙する前のイベントは届いている");

  const ev = lastExecEvent(root);
  assert.equal((ev?.meta as { timeoutKind?: string })?.timeoutKind, "idle");
});

// 故障注入 3 — ⚠️ **これが誤 kill を防ぐ側のテスト。**
// 実測で 412s 沈黙してから作業を続けた実行があった（E2E 実行中）。
// 閾値未満の沈黙で殺すと、その実行を失う。
test("watchdog: a long-but-under-threshold silence does not kill the run", async () => {
  const { root, config: base } = makeRoot();
  setStep(root, "implementation");
  const config = configWith(base, { codexTimeoutMs: 3_000, codexIdleTimeoutMs: 600 });
  // 3 イベント出したあと 300ms 沈黙し（閾値 600ms 未満）、その後再開する
  const { executor } = pulsingExecutor({ everyMs: 20, silentAfter: 3, resumeAfterMs: 300 });

  const result = await execStep(root, config, "implementation", { executor });

  assert.equal(
    (result.meta as { timeoutKind?: string }).timeoutKind,
    "total",
    "沈黙で殺されず、総上限まで走り切る（= idle では撃たれていない）"
  );
});

// 故障注入 4
test("watchdog: steps.<id>.timeoutMs overrides the settings default", async () => {
  const { root, config: base } = makeRoot();
  setStep(root, "implementation");
  const config = configWith(base, { codexTimeoutMs: 20_000, codexIdleTimeoutMs: 10_000 }, { timeoutMs: 300 });

  let seen: number | undefined;
  const spy: StepExecutor = {
    name: "codex",
    async execute(req) {
      seen = req.timeoutMs; // **エンジンが解決して渡す**（executor は yaml を読み直さない）
      while (!req.signal?.aborted) await sleep(20);
      return { ok: false, outputs: [], error: "timeout", failureKind: "transient" };
    }
  };

  const started = Date.now();
  const result = await execStep(root, config, "implementation", { executor: spy });
  const elapsed = Date.now() - started;

  assert.equal(seen, 300, "ExecutorRequest.timeoutMs にステップ側の値が入る");
  assert.equal((result.meta as { timeoutKind?: string }).timeoutKind, "total");
  assert.ok(elapsed < 20_000, `settings の 20s ではなく step の 300ms が効く（実測 ${elapsed}ms）`);
});

// 故障注入 5 — M3 防衛線1 の再確認。**ウォッチドッグ経由の kill でも同じであること。**
test("watchdog: after a watchdog kill, a fresh re-run from artifacts alone completes", async () => {
  const { root, config: base } = makeRoot();
  setStep(root, "implementation");
  const config = configWith(base, { codexTimeoutMs: 250, codexIdleTimeoutMs: 10_000 });

  const killed = await execStep(root, config, "implementation", { executor: pulsingExecutor({ everyMs: 20 }).executor });
  assert.equal(killed.ok, false);
  assert.equal(existsSync(path.join(root, "current-result.md")), true, "テンプレは残っている");

  // 2回目: セッションも履歴も持たず、入力成果物だけを見て成果物を書く executor
  const fresh: StepExecutor = {
    name: "codex",
    async execute(req) {
      assert.equal(req.signal?.aborted, false, "新しい実行は前回の signal を引き継がない");
      const task = readFileSync(path.join(req.root, "current-task.md"), "utf8");
      writeFileSync(path.join(req.root, "current-result.md"), `# Summary\n\n${task.length} bytes read\n`, "utf8");
      return { ok: true, outputs: ["current-result.md"], failureKind: undefined };
    }
  };
  const again = await execStep(root, config, "implementation", { executor: fresh });

  assert.equal(again.ok, true, "**入力ファイルだけから完走する**（不変条件2）");
  assert.equal((again.meta as { timeoutKind?: string } | undefined)?.timeoutKind, undefined, "成功に種別は付かない");
  assert.match(readFileSync(path.join(root, "current-result.md"), "utf8"), /bytes read/);
});

// 単体: 二重発火しない / 外部中断は「タイムアウト」として記録しない
test("watchdog: the first reason wins, and an external abort is not recorded as a timeout", async () => {
  const external = new AbortController();
  const w = createWatchdog({ totalTimeoutMs: 10_000, idleTimeoutMs: 50, externalSignal: external.signal });
  await sleep(120);
  assert.equal(w.firedKind(), "idle");
  w.dispose();

  const w2 = createWatchdog({ totalTimeoutMs: 10_000, idleTimeoutMs: 10_000, externalSignal: external.signal });
  external.abort();
  assert.equal(w2.signal.aborted, true, "外部中断は executor へ伝わる");
  assert.equal(w2.firedKind(), null, "**人間が止めたことをタイムアウトと記録しない**");
  w2.dispose();
});

// 単体: KI-08 の二重判定
test("watchdog: classifyTimeout also trusts the measured duration (KI-08)", () => {
  assert.equal(classifyTimeout(null, 999, 1000), null, "撃っておらず時間内なら null");
  assert.equal(classifyTimeout(null, 1000, 1000), "total", "タイマーが撃たなくても実測が超えていれば total");
  assert.equal(classifyTimeout("idle", 5, 1000), "idle", "撃った理由が優先される");
});

// ── 追加分（レビュー指摘への対応）───────────────────────────────

// ⚠️ **codex.ts の 30 分フォールバックが「死んでいると証明された既定」であること。**
// codex.ts は不変の縛りがあるため CODEX_DEFAULT_TIMEOUT_MS を消せない。
// 消せない代わりに、**エンジン経由なら必ず timeoutMs が埋まる**ことを固定する。
// これが無いと「本番では使われない」は宣言でしかなく、KI-09 の系譜になる。
test("watchdog: the engine always fills request.timeoutMs (the executor default is unreachable)", async () => {
  const { root, config: base } = makeRoot();
  setStep(root, "implementation");

  const seen: (number | undefined)[] = [];
  const probe: StepExecutor = {
    name: "codex",
    async execute(req) {
      seen.push(req.timeoutMs);
      return { ok: true, outputs: [] };
    }
  };

  // (1) settings も step も未指定 → エンジンの既定が入る（executor 側の既定には落ちない）
  const bare = { ...base, settings: { ...base.settings, codexTimeoutMs: undefined, codexIdleTimeoutMs: undefined } };
  await execStep(root, bare, "implementation", { executor: probe });
  // (2) settings 指定
  await execStep(root, configWith(base, { codexTimeoutMs: 1234 }), "implementation", { executor: probe });
  // (3) step 指定（settings より優先）
  await execStep(root, configWith(base, { codexTimeoutMs: 1234 }, { timeoutMs: 999 }), "implementation", { executor: probe });

  assert.deepEqual(seen, [DEFAULT_TOTAL_TIMEOUT_MS, 1234, 999]);
  assert.ok(
    seen.every((v) => typeof v === "number"),
    "**どの経路でも undefined を渡さない**（渡すと executor の既定に落ちる）"
  );
});

// ⚠️ **理由の混線が無いこと**（レビュー指摘 3）。
// kill 遅延を含む durationMs は総上限を超えうるが、**撃った理由が優先される**。
test("watchdog: an idle kill stays 'idle' even when the measured duration exceeds the total cap", () => {
  // 単体: idle で撃ったあと、実測が総上限を超えていても total へ倒れない
  assert.equal(classifyTimeout("idle", 5000, 1000), "idle", "実測が総上限超でも撃った理由が勝つ");
  assert.equal(classifyTimeout("idle", 1000, 1000), "idle", "境界でも同じ");
  assert.equal(classifyTimeout("total", 5000, 1000), "total");
});

test("watchdog: an idle kill reports only the idle reason end to end", async () => {
  const { root, config: base } = makeRoot();
  setStep(root, "implementation");
  // 総上限を極端に短くし、**idle が先に撃ったあと居座る**状況を作る。
  // 居座り中に実測時間は総上限を超える（実運用の SIGTERM 遅延 237s と同じ形）。
  const config = configWith(base, { codexTimeoutMs: 900, codexIdleTimeoutMs: 200 });
  const lingering: StepExecutor = {
    name: "codex",
    async execute(req) {
      req.onProgress?.({ kind: "message", text: "start" });
      while (!req.signal?.aborted) await sleep(20); // 200ms 沈黙 → idle が撃つ
      await sleep(900); // **撃たれてから居座る**。実測は総上限 900ms を超える
      return { ok: false, outputs: [], error: "codex executor: タイムアウト", failureKind: "transient" };
    }
  };

  const started = Date.now();
  const result = await execStep(root, config, "implementation", { executor: lingering });
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 900, `居座りで実測が総上限を超えている（実測 ${elapsed}ms）`);
  assert.equal((result.meta as { timeoutKind?: string }).timeoutKind, "idle", "**total へ誤分類しない**");
  assert.match(result.error ?? "", /無進行タイムアウト/);
  assert.doesNotMatch(result.error ?? "", /総上限/, "理由文字列が混線しない");
});

// 沈黙の実測が Event Log に載ること（次に閾値を見直すときの一次資料）。
test("watchdog: idle observations are recorded even for successful runs", async () => {
  const { root, config: base } = makeRoot();
  setStep(root, "implementation");
  const config = configWith(base, { codexTimeoutMs: 10_000, codexIdleTimeoutMs: 5_000 });

  const withPause: StepExecutor = {
    name: "codex",
    async execute(req) {
      req.onProgress?.({ kind: "message", text: "a" });
      await sleep(250); // ここが最大の沈黙になる
      req.onProgress?.({ kind: "message", text: "b" });
      return { ok: true, outputs: [] };
    }
  };
  await execStep(root, config, "implementation", { executor: withPause });

  const ev = lastExecEvent(root);
  assert.equal(ev?.event, "exec.completed", "**成功した実行でも記録する**（分布の本体はこちら）");
  const meta = ev?.meta as { maxIdleMs?: number; progressEvents?: number; topIdleMs?: number[] };
  assert.equal(meta.progressEvents, 2);
  assert.ok((meta.maxIdleMs ?? 0) >= 200, `観測した最大沈黙が載る（${meta.maxIdleMs}ms）`);
  assert.ok(Array.isArray(meta.topIdleMs) && meta.topIdleMs.length > 0, "裾を見るための上位も載る");
  assert.equal(meta.topIdleMs?.[0], meta.maxIdleMs, "topIdleMs の先頭は maxIdleMs と一致する");
});

// 一度も進まなかった実行を「1件来た」と誤らない（armIdle と notify を分けた理由）。
test("watchdog: a run that never progressed records zero events", async () => {
  const { root, config: base } = makeRoot();
  setStep(root, "implementation");
  const config = configWith(base, { codexTimeoutMs: 10_000, codexIdleTimeoutMs: 200 });
  const silent: StepExecutor = {
    name: "codex",
    async execute(req) {
      while (!req.signal?.aborted) await sleep(20);
      return { ok: false, outputs: [], error: "timeout", failureKind: "transient" };
    }
  };
  await execStep(root, config, "implementation", { executor: silent });

  const meta = lastExecEvent(root)?.meta as { progressEvents?: number; maxIdleMs?: number; timeoutKind?: string };
  assert.equal(meta.progressEvents, 0, "**構築時の arm をイベントとして数えない**");
  assert.equal(meta.timeoutKind, "idle");
  assert.ok((meta.maxIdleMs ?? 0) >= 200, "起動から最初のイベントまでの沈黙も数える");
});
