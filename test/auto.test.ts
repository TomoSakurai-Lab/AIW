// M5 段階2: `aiw auto` の停止条件・予算・再試行・ロック・安全弁の固定（故障注入 #1-#21・#23・#24）。
//
// 設計は docs/design-auto.md。**停止条件の番号（A1〜A25）と故障注入の番号（#n）はその文書の表と対応する。**
// 表を変えたらここも変える。どちらか一方だけを変えない。
//
// 区間は config をメモリ上で書き換えて作る（implementation / review / fix / improve-check に executor と auto: true）。
// executor は偽物（test seam）だが、**タイムアウトは実物の watchdog で撃つ**（timeoutKind はエンジンが書く値を使い、
// 偽の executor に書かせない）。exec が state を書かないこと・run の判定は実物のまま。
//
// ⚠️ clipboard のステップへ進む経路は、auto が exec の**前に**止まる（A2）ので OS のクリップボードに触れない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  AUTO_EXIT,
  acquireAutoLock,
  autoIneligibility,
  returnsToDrive,
  autoLockFile,
  deriveAutoBudget,
  findUnboundedCycle,
  resolveAutoBudget,
  resolveAutoRetry,
  runAuto,
  type AutoOptions
} from "../src/engine/auto.js";
import { EngineError, loadConfig } from "../src/engine/engine.js";
import { captureIfAbsent } from "../src/engine/gitScope.js";
import type { ExecutorRequest, ExecutorResult, StepExecutor } from "../src/engine/executors/types.js";
import { loadWorkflow } from "../src/engine/loader.js";
import { readEventLog, buildObserved } from "../src/engine/observed.js";
import { rootPaths } from "../src/engine/paths.js";
import { PromptAssemblyError } from "../src/engine/promptAssembly.js";
import { readState, updateState } from "../src/engine/state.js";
import { buildSummary, formatSummary } from "../src/engine/summary.js";
import type { WorkflowConfig } from "../src/engine/types.js";
import { makeRoot, setStep, validResult, validReview, writeIn, writeStatus } from "./helpers.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// runtime の宣言（2026-09-25）と同じ区間: この4つだけに executor と auto: true
const ZONE: Record<string, "codex" | "claude"> = {
  implementation: "codex",
  review: "claude",
  fix: "codex",
  "improve-check": "claude"
};

function zoned(config: WorkflowConfig, patch: (steps: WorkflowConfig["steps"]) => void = () => {}): WorkflowConfig {
  const steps = { ...config.steps };
  for (const [id, executor] of Object.entries(ZONE)) {
    steps[id] = { ...steps[id], executor, auto: true };
  }
  patch(steps);
  return { ...config, steps };
}

/** ステップの成果物と status を書く（executor が正常に仕事をした状態） */
function produce(root: string, step: string, result: string): ExecutorResult {
  if (step === "implementation" || step === "fix") {
    writeIn(root, "current-result.md", validResult);
  }
  if (step === "review") {
    writeIn(root, "current-review.md", validReview);
  }
  writeStatus(root, { step, result, reason: "fake executor" });
  return { ok: true, outputs: ["current-status.json"], meta: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 } } };
}

const RESULT_OF: Record<string, string> = {
  implementation: "implemented",
  review: "ready",
  fix: "fixed",
  "improve-check": "ready-for-reflection"
};

type Behaviour = (req: ExecutorRequest, call: number) => Promise<ExecutorResult> | ExecutorResult;

/** 偽の executor。既定は「ステップの成果物と既定の result を書く」。calls に呼ばれたステップを記録する */
function fake(root: string, behaviour?: Behaviour): { executor: StepExecutor; calls: string[] } {
  const calls: string[] = [];
  const executor: StepExecutor = {
    name: "codex",
    async execute(req) {
      calls.push(req.step.id);
      return behaviour ? behaviour(req, calls.length) : produce(root, req.step.id, RESULT_OF[req.step.id]);
    }
  };
  return { executor, calls };
}

/** abort されるまで返らない executor（watchdog か auto の Ctrl+C でだけ終わる） */
function hangUntilAborted(req: ExecutorRequest): Promise<ExecutorResult> {
  return new Promise((resolve) => {
    const done = (): void => resolve({ ok: false, outputs: [], failureKind: "transient", error: "aborted" });
    if (req.signal?.aborted) {
      done();
      return;
    }
    req.signal?.addEventListener("abort", done, { once: true });
  });
}

const transient = (error = "Selected model is at capacity. Please try a different model."): ExecutorResult => ({
  ok: false,
  outputs: [],
  failureKind: "transient",
  error
});

function autoEvents(root: string): Array<Record<string, unknown>> {
  const log = readEventLog(root);
  assert.ok(Array.isArray(log));
  return log.filter((r) => String(r.event).startsWith("auto."));
}

function stateText(root: string): string {
  return readFileSync(rootPaths(root).stateFile, "utf8");
}

/**
 * fix へ入った直後の状態を作る。遷移確定時と同じく baseline を取る
 * （取らずに setStep だけで入ると、fix の diff-scope は halt 宣言なので A7 で止まる。それは auto の性質ではない）。
 */
function enterFix(root: string, fixAttempts = 1): void {
  setStep(root, "fix", { fixAttempts });
  captureIfAbsent(root, loadConfig(root), { step: "fix", fixAttempts });
}

/** 待機を記録するだけの sleep（実時間は待たない） */
function recordingSleep(): { waits: number[]; sleep: NonNullable<AutoOptions["sleep"]> } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

// ---------------------------------------------------------------------------------------------
// 人の番（終了コード 0）: A1-A4 と、区間の境界（#12 #13 #21）・遷移直後の状態（#24）

// Test 195 — 区間の境界。research（区間外）・reflection（clipboard）・clipboard へ戻したステップでは何も実行せずに 0。
test("195: auto stops before exec at out-of-zone (A3) and clipboard (A2) steps, including a rolled-back step (#12 #13 #21)", async () => {
  const { root, config } = makeRoot();
  const cfg = zoned(config, (s) => {
    s.research = { ...s.research, executor: "claude" }; // runtime と同じ: executor はあるが auto は付けない
  });
  const { executor, calls } = fake(root);

  setStep(root, "research");
  const research = await runAuto(root, cfg, { executor });
  assert.equal(research.condition, "A3");
  assert.equal(research.stop, "out-of-zone");
  assert.equal(research.exitCode, AUTO_EXIT.humanTurn);
  assert.match(research.line, /auto の対象外: research（executor: claude）/);

  setStep(root, "reflection");
  const reflection = await runAuto(root, cfg, { executor });
  assert.equal(reflection.condition, "A2");
  assert.equal(reflection.exitCode, 0);
  assert.match(reflection.line, /人の番: reflection は clipboard/);

  // 不変条件5: executor の1行を消して clipboard へ戻す（auto: true は残っている）→ auto は A2 で止まる
  const rolledBack = zoned(config, (s) => {
    s.implementation = { ...s.implementation, executor: "clipboard" };
  });
  setStep(root, "implementation");
  const rb = await runAuto(root, rolledBack, { executor });
  assert.equal(rb.condition, "A2");
  assert.equal(rb.exitCode, 0);

  assert.deepEqual(calls, [], "どの停止でも executor を呼ばない");
  assert.equal(readState(root).currentStep, "implementation", "state は変わらない");
});

// Test 196 — 承認待ち（A1）と完了（A4）は 0。起動時に既に承認待ちでも同じ。
test("196: a gate (A1) and the terminal (A4) are the human's turn, exit 0", async () => {
  const { root, config } = makeRoot();
  const cfg = zoned(config);
  const { executor, calls } = fake(root);

  setStep(root, "review", { pendingApproval: "review", status: "awaiting-approval" });
  const gate = await runAuto(root, cfg, { executor });
  assert.equal(gate.condition, "A1");
  assert.equal(gate.stop, "gate");
  assert.equal(gate.exitCode, 0);
  assert.match(gate.line, /承認待ち: review — aiw approve \/ aiw reject/);

  setStep(root, "complete");
  const done = await runAuto(root, cfg, { executor });
  assert.equal(done.condition, "A4");
  assert.equal(done.exitCode, 0);

  setStep(root, "not-a-step");
  const unknown = await runAuto(root, cfg, { executor });
  assert.equal(unknown.condition, "A25");
  assert.equal(unknown.exitCode, AUTO_EXIT.refused);

  assert.deepEqual(calls, []);
});

// Test 197 — 区間②→③: implementation → review を無人で走り、review の承認待ちで止まる。
// あわせて #18: report 違反（verify-local の失敗）は**停止に格上げしない**。表示とサマリの行には出る。
test("197: implementation → review runs unattended and stops at the review gate; report violations do not stop it (#18)", async () => {
  const { root, config, repoRoot } = makeRoot();
  const bad = path.join(repoRoot, "typecheck-fail.js");
  writeFileSync(bad, ["console.log('C:/repo/src/a.ts');", "console.error('src/a.ts(1,1): error TS1005: oops');", "process.exit(2);"].join("\n"), "utf8");
  const cfg = zoned({ ...config, settings: { ...config.settings, verifyLocal: { typecheck: { command: [process.execPath, bad] } } } });
  writeIn(root, "context-package.md", "# Files\n## Modify\n- `x.ts`\n");
  const { executor, calls } = fake(root);
  setStep(root, "implementation");

  const reported: string[] = [];
  const r = await runAuto(root, cfg, {
    executor,
    reporter: { outcome: (o) => void ((o.kind === "transitioned" || o.kind === "awaiting-approval") && o.notice && reported.push(...o.notice.reported.map((n) => n.type))) }
  });

  assert.deepEqual(calls, ["implementation", "review"]);
  assert.equal(r.condition, "A1");
  assert.equal(r.step, "review");
  assert.equal(r.exitCode, 0);
  assert.ok(reported.includes("verify-local"), "report は表示側へ渡る");
  assert.equal(r.executed[0].result, "→ review");
  assert.ok(r.executed[0].reported.some((x) => x.startsWith("verify-local")), "停止サマリの行にも出る");
  assert.equal(r.executed[1].result, "awaiting-approval");
  assert.equal(readState(root).pendingApproval, "review", "承認はしない");
});

// Test 198 — 区間③→: fix ⇄ improve-check の最悪経路（6回）は escalation で止まり、予算 8 には当たらない。
// fix-incomplete を2回返したあと ready-for-reflection なら reflection（clipboard）で止まる。
test("198: the fix ⇄ improve-check loop ends at escalation (A5, exit 2) or reflection (A2), never at the budget", async () => {
  const { root, config } = makeRoot();
  const cfg = zoned(config);

  // 最悪経路: improve-check が毎回 fix-incomplete
  enterFix(root);
  const worst = fake(root, (req) => produce(root, req.step.id, req.step.id === "fix" ? "fixed" : "fix-incomplete"));
  const halted = await runAuto(root, cfg, { executor: worst.executor });
  assert.deepEqual(worst.calls, ["fix", "improve-check", "fix", "improve-check", "fix", "improve-check"]);
  assert.equal(halted.condition, "A5");
  assert.equal(halted.stop, "halted");
  assert.equal(halted.exitCode, AUTO_EXIT.halted);
  assert.match(halted.line, /HALT\(escalation\) improve-check/);
  assert.equal(halted.budget?.total, 8);
  assert.equal(readState(root).status, "halted", "resume しない");

  // 2回で収束
  const { root: root2, config: config2 } = makeRoot();
  enterFix(root2);
  let ic = 0;
  const twice = fake(root2, (req) => produce(root2, req.step.id, req.step.id === "fix" ? "fixed" : ++ic < 3 ? "fix-incomplete" : "ready-for-reflection"));
  const done = await runAuto(root2, zoned(config2), { executor: twice.executor });
  assert.equal(twice.calls.length, 6);
  assert.equal(done.condition, "A2");
  assert.equal(done.step, "reflection");
  assert.equal(done.exitCode, 0);
});

// Test 199 — #24: **遷移の直後の普通の状態**（current-status.json が遷移元の宣言のまま）で起動しても止まらずに exec する。
// stale の検査は exec の後にだけ行う（設計 課題E の初版の誤りの再発防止）。
test("199: right after a transition (status still declares the previous step) auto execs instead of stopping (#24)", async () => {
  const { root, config } = makeRoot();
  setStep(root, "improve-check", { lastCompletedStep: "fix", fixAttempts: 1 });
  writeIn(root, "current-result.md", validResult);
  writeStatus(root, { step: "fix", result: "fixed", reason: "遷移元の宣言" });
  const { executor, calls } = fake(root);

  const r = await runAuto(root, zoned(config), { executor });
  assert.deepEqual(calls, ["improve-check"]);
  assert.equal(r.condition, "A2", "improve-check → reflection まで進んでから clipboard で止まる");
});

// ---------------------------------------------------------------------------------------------
// halt（終了コード 2）: #14 #15 #19

// Test 200 — halt の各種（escalation は 198）。auto は resume せず、state は run が書いたまま。
test("200: invalid-status (A6) and validation-failed (A7) stop with exit 2 and are not resumed (#14)", async () => {
  const { root, config } = makeRoot();
  const cfg = zoned(config);

  setStep(root, "improve-check", { fixAttempts: 1 });
  const invalid = fake(root, (req) => produce(root, req.step.id, "approved"));
  const a6 = await runAuto(root, cfg, { executor: invalid.executor });
  assert.equal(a6.condition, "A6");
  assert.equal(a6.exitCode, 2);
  assert.match(a6.line, /許可: ready-for-reflection \| fix-incomplete/);
  assert.deepEqual(invalid.calls, ["improve-check"], "halt の後に何も実行しない");

  const { root: r2, config: c2 } = makeRoot();
  enterFix(r2);
  writeIn(r2, "current-result.md", validResult);
  // status だけ書いて current-result.md を消す → file-exists（halt 宣言）
  const noResult = fake(r2, () => {
    writeStatus(r2, { step: "fix", result: "fixed", reason: "x" });
    return { ok: true, outputs: [] };
  });
  rmSync(path.join(r2, "current-result.md"));
  const a7 = await runAuto(r2, zoned(c2), { executor: noResult.executor });
  assert.equal(a7.condition, "A7");
  assert.equal(a7.exitCode, 2);
  assert.equal(readState(r2).haltedReason, "validation-failed");
});

// Test 201 — #15 / #19: 起動時に既に halt なら何も実行せず 2（A10）。**state は1バイトも変わらない**（resume しない）。
test("201: starting on a halted state executes nothing, exits 2 (A10) and leaves state.json byte-identical (#15 #19)", async () => {
  const { root, config } = makeRoot();
  setStep(root, "fix", { status: "halted", haltedReason: "validation-failed", fixAttempts: 2 });
  const before = stateText(root);
  const { executor, calls } = fake(root);

  const r = await runAuto(root, zoned(config), { executor });
  assert.equal(r.condition, "A10");
  assert.equal(r.exitCode, 2);
  assert.match(r.line, /既に HALT\(validation-failed\) fix — auto は resume しない/);
  assert.deepEqual(calls, []);
  assert.equal(stateText(root), before, "state.json は変わらない");
});

// Test 202 — #19 の import 検査: auto は承認・却下・halt の resume の口・state の書き込み・baseline の取り直しを持たない。
// 振る舞いの側は 201（halt で state が変わらない）と 196（承認待ちで承認しない）。
test("202: engine/auto.ts has no path to approve / reject / write state / re-fix the baseline (#19)", () => {
  const source = readFileSync(path.join(PKG, "src", "engine", "auto.ts"), "utf8");
  const imports = source
    .split(/\r?\n/)
    .filter((line) => line.startsWith("import "))
    .join("\n");
  for (const name of ["approve", "reject", "writeState", "updateState", "captureIfAbsent", "writeRejectionNote"]) {
    assert.doesNotMatch(imports, new RegExp(`\\b${name}\\b`), `auto.ts が ${name} を import している`);
  }
  // baseline の取り直し（対話 CLI 専用）は名前すら出さない（Test 58 と同じ規律を auto.ts へ明示的に広げる）
  assert.doesNotMatch(source, /recapture/i);
  // resume は import してよいが、チェックポイントの分岐の中だけで呼ぶ
  const resumeCalls = source.split(/\r?\n/).filter((line) => /\bresume\(root/.test(line));
  assert.equal(resumeCalls.length, 1, "resume の呼び出しは1箇所（checkpoint）だけ");
});

// ---------------------------------------------------------------------------------------------
// 再開の冪等性: #1 #2 と同時実行のロック #17

// Test 203 — #1: exec 中に auto が死んだ（ロックが残り、state は変わっていない）→ 再起動は古いロックを引き継ぎ、
// **同じステップを fresh で再実行して**続ける。exec は state を書かない（不変条件1）ので、死んだ時点の state のまま。
test("203: after auto dies mid-exec, a restart takes over the stale lock and re-runs the same step fresh (#1)", async () => {
  const { root, config } = makeRoot();
  const cfg = zoned(config);
  enterFix(root);
  writeIn(root, "current-result.md", "# 書きかけ\n");
  const before = stateText(root);

  // 1回目: exec の途中でプロセスが死ぬ（executor が戻らないまま終わる）ことを、例外で模す
  const dying = fake(root, () => {
    throw new Error("process killed");
  });
  await assert.rejects(runAuto(root, cfg, { executor: dying.executor }), /process killed/);
  assert.equal(stateText(root), before, "exec 中の死は state を変えない");
  // 本物の kill では finally が走らずロックが残る。その状態を作る（pid は存在しない番号）
  writeFileSync(autoLockFile(root), JSON.stringify({ pid: 999_999, startedAt: "2026-09-25T00:00:00.000Z", runId: "auto-dead" }), "utf8");

  const again = fake(root, (req) => produce(root, req.step.id, req.step.id === "fix" ? "fixed" : "ready-for-reflection"));
  const r = await runAuto(root, cfg, { executor: again.executor, isAlive: () => false });
  assert.deepEqual(again.calls, ["fix", "improve-check"], "死んだステップ（fix）から fresh で続く");
  assert.equal(r.condition, "A2");
  const started = autoEvents(root).find((e) => e.event === "auto.started" && e.lockTakenOver);
  assert.ok(started, "古いロックを引き継いだことを記録する");
  assert.equal((started!.lockTakenOver as { runId: string }).runId, "auto-dead");
  assert.equal(existsSync(autoLockFile(root)), false, "終われば自分のロックを外す");
});

// Test 204 — #2: postActions の途中で止まった遷移（チェックポイント）は resume して続ける。
test("204: a post-action checkpoint is resumed and the loop continues (#2)", async () => {
  const { root, config } = makeRoot();
  setStep(root, "fix", {
    fixAttempts: 1,
    status: "running",
    pendingTransition: { from: "fix", to: "improve-check", result: "fixed", isRetry: false, completedPostActions: [] }
  });
  writeIn(root, "current-result.md", validResult);
  writeStatus(root, { step: "fix", result: "fixed", reason: "x" });
  const { executor, calls } = fake(root);
  const resumed: string[] = [];

  const r = await runAuto(root, zoned(config), { executor, reporter: { resumed: (o) => void resumed.push(o.kind) } });
  assert.deepEqual(resumed, ["transitioned"]);
  assert.deepEqual(calls, ["improve-check"], "fix は再実行しない（チェックポイントから続ける）");
  assert.equal(r.condition, "A2");
});

// Test 205 — #17: 同時起動の2つ目は 1 で拒否（A23）。持ち主の pid が無いロックは引き継ぐ。読めないロックは拒否（安全側）。
test("205: a second concurrent auto is refused with exit 1 (A23); a dead holder's lock is taken over (#17)", async () => {
  const { root, config } = makeRoot();
  const cfg = zoned(config);
  enterFix(root);

  // 1つ目が exec の途中にいる間に、2つ目を起動する（同じプロセス = pid は生きている）
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = fake(root, async (req) => {
    await gate;
    return produce(root, req.step.id, req.step.id === "fix" ? "fixed" : "ready-for-reflection");
  });
  const running = runAuto(root, cfg, { executor: first.executor });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = fake(root);
  const refused = await runAuto(root, cfg, { executor: second.executor });
  assert.equal(refused.condition, "A23");
  assert.equal(refused.stop, "refused");
  assert.equal(refused.exitCode, AUTO_EXIT.refused);
  assert.match(refused.line, new RegExp(`別の aiw auto が実行中（pid ${process.pid}, 開始 \\d\\d:\\d\\d）`));
  assert.deepEqual(second.calls, [], "拒否された側は何も実行しない");
  release();
  assert.equal((await running).condition, "A2", "1つ目は影響を受けない");
  assert.ok(autoEvents(root).some((e) => e.event === "auto.refused" && e.condition === "A23"));

  // 古いロック: 持ち主が居なければ引き継ぐ / 生きていれば拒否 / 読めなければ拒否
  const lock = { pid: 4242, startedAt: new Date().toISOString(), runId: "auto-x" };
  writeFileSync(autoLockFile(root), JSON.stringify({ pid: 1, startedAt: "t", runId: "auto-old" }), "utf8");
  assert.deepEqual(acquireAutoLock(root, lock, () => false), { ok: true, takenOver: { pid: 1, startedAt: "t", runId: "auto-old" } });
  assert.equal(acquireAutoLock(root, { ...lock, runId: "auto-y" }, () => true).ok, false);
  writeFileSync(autoLockFile(root), "{", "utf8");
  assert.deepEqual(acquireAutoLock(root, lock, () => false), { ok: false, holder: null });
});

// ---------------------------------------------------------------------------------------------
// 中断（終了コード 130）: #3 #4 #5

// Test 206 — #3: exec 中の Ctrl+C。再試行しない・130・state は変わらない。
test("206: Ctrl+C during exec stops with 130 (A20) without retrying and without touching state (#3)", async () => {
  const { root, config } = makeRoot();
  enterFix(root);
  const before = stateText(root);
  const controller = new AbortController();
  const { executor, calls } = fake(root, (req) => {
    setTimeout(() => controller.abort(), 20);
    return hangUntilAborted(req);
  });

  const r = await runAuto(root, zoned(config), { executor, signal: controller.signal });
  assert.equal(r.condition, "A20");
  assert.equal(r.exitCode, 130);
  assert.deepEqual(calls, ["fix"], "再試行しない（人間の Ctrl+C は transient に見えても再試行の対象ではない）");
  assert.equal(autoEvents(root).filter((e) => e.event === "auto.retry").length, 0);
  assert.equal(stateText(root), before);
});

// Test 207 — #4: 再試行の待機中の Ctrl+C は待機を打ち切って 130。
test("207: Ctrl+C during a retry wait cuts the wait short and exits 130 (#4)", async () => {
  const { root, config } = makeRoot();
  enterFix(root);
  const controller = new AbortController();
  const { executor, calls } = fake(root, () => transient());
  const started = Date.now();

  const r = await runAuto(root, zoned(config), {
    executor,
    signal: controller.signal,
    reporter: { retrying: () => void setTimeout(() => controller.abort(), 20) }
  }); // 実物の abortableSleep（5分）を使う
  assert.equal(r.condition, "A20");
  assert.equal(r.exitCode, 130);
  assert.match(r.line, /再試行の待機を打ち切った/);
  assert.deepEqual(calls, ["fix"]);
  assert.ok(Date.now() - started < 10_000, "5分の待機を待たずに戻る");
});

// Test 208 — #5（auto の側）: 中断済みで起動したら executor を呼ばない。
// ⚠️ executor 側の「abort 済みの signal なら起動しない」は codex だけが満たす（Test 173）。claude は起動してから即 kill する
//    （executor の変更は M5 のやらないこと。完了報告で報告済み）。auto は exec の前に自分の signal を見るので、その経路へ入らない。
test("208: an already-aborted auto never calls the executor (#5, auto side)", async () => {
  const { root, config } = makeRoot();
  enterFix(root);
  const controller = new AbortController();
  controller.abort();
  const { executor, calls } = fake(root);

  const r = await runAuto(root, zoned(config), { executor, signal: controller.signal });
  assert.equal(r.condition, "A20");
  assert.equal(r.exitCode, 130);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------------------------
// executor 失敗（終了コード 4）: #6 #7 #8 #23 と組み立て失敗

// Test 209 — #6: permanent は再試行しない・4。
test("209: a permanent failure is not retried and exits 4 (A12) (#6)", async () => {
  const { root, config } = makeRoot();
  enterFix(root);
  const before = stateText(root);
  const { executor, calls } = fake(root, () => ({ ok: false, outputs: [], failureKind: "permanent", error: "CLAUDE_CONFIG_DIR が無い" }));

  const r = await runAuto(root, zoned(config), { executor });
  assert.equal(r.condition, "A12");
  assert.equal(r.exitCode, AUTO_EXIT.execFailed);
  assert.match(r.line, /executor 失敗\(permanent\) fix: CLAUDE_CONFIG_DIR が無い/);
  assert.deepEqual(calls, ["fix"]);
  assert.equal(stateText(root), before, "exec の失敗は state を変えない");
});

// Test 210 — #7 / #23: タイムアウトは **実物の watchdog** で撃つ。総上限は即時に1回、無進行は 5分待って1回。
// **total / idle を分けた設計が初めて挙動の分岐に使われる**（#6 の承認時の修正）。分岐は timeoutKind で行い、理由文字列を読まない。
test("210: total-timeout retries once immediately; idle-timeout waits 5 minutes then retries once (#7 #23)", async () => {
  // 総上限: step.timeoutMs を短くし、無進行は長く
  {
    const { root, config } = makeRoot();
    enterFix(root);
    const cfg = zoned(config, (s) => {
      s.fix = { ...s.fix, timeoutMs: 30 };
    });
    const { executor, calls } = fake(root, (req) => hangUntilAborted(req));
    const { waits, sleep } = recordingSleep();
    const r = await runAuto(root, cfg, { executor, sleep });
    assert.equal(r.condition, "A13a");
    assert.equal(r.exitCode, 4);
    assert.match(r.line, /executor 失敗\(total-timeout ×2\) fix/);
    assert.deepEqual(calls, ["fix", "fix"], "1回だけ再試行");
    assert.deepEqual(waits, [], "即時（待たない）");
    const retries = autoEvents(root).filter((e) => e.event === "auto.retry");
    assert.deepEqual(retries.map((e) => [e.cause, e.waitMs, e.attempt]), [["total-timeout", 0, 1]]);
  }
  // 無進行: executorIdleTimeoutMs を短くし、総上限は長く
  {
    const { root, config } = makeRoot();
    enterFix(root);
    const cfg = zoned({ ...config, settings: { ...config.settings, executorIdleTimeoutMs: 30 } }, (s) => {
      s.fix = { ...s.fix, timeoutMs: 60_000 };
    });
    const { executor, calls } = fake(root, (req) => hangUntilAborted(req));
    const { waits, sleep } = recordingSleep();
    const order: string[] = [];
    const r = await runAuto(root, cfg, {
      executor: { name: "codex", execute: async (req) => (order.push("exec"), executor.execute(req)) },
      sleep: async (ms, s) => (order.push(`sleep ${ms}`), sleep(ms, s))
    });
    assert.equal(r.condition, "A13b");
    assert.match(r.line, /executor 失敗\(idle-timeout ×2\) fix/);
    assert.deepEqual(calls, ["fix", "fix"], "1回だけ再試行");
    assert.deepEqual(waits, [300_000], "5分待つ（即時ではない）");
    assert.deepEqual(order, ["exec", "sleep 300000", "exec"], "待ってから再試行する");
    const retries = autoEvents(root).filter((e) => e.event === "auto.retry");
    assert.deepEqual(retries.map((e) => [e.cause, e.waitMs]), [["idle-timeout", 300_000]]);
  }
});

// Test 211 — #8: その他の transient は 5分 / 15分 / 30分 待って3回、4回目の失敗で 4。`auto.retry` が3件。
// 起動あたりの再試行の総数（maxPerRun）でも止まる。
test("211: other transients retry 3 times after 5 / 15 / 30 minutes, then exit 4 (A14); maxPerRun caps the total (#8)", async () => {
  const { root, config } = makeRoot();
  enterFix(root);
  const { executor, calls } = fake(root, () => transient());
  const { waits, sleep } = recordingSleep();

  const r = await runAuto(root, zoned(config), { executor, sleep });
  assert.equal(r.condition, "A14");
  assert.equal(r.exitCode, 4);
  assert.match(r.line, /executor 失敗\(transient ×4\) fix: Selected model is at capacity/);
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [300_000, 900_000, 1_800_000]);
  const retries = autoEvents(root).filter((e) => e.event === "auto.retry");
  assert.equal(retries.length, 3);
  assert.deepEqual(retries.map((e) => e.attempt), [1, 2, 3]);
  const started = autoEvents(root).find((e) => e.event === "auto.started")!;
  assert.deepEqual((started.retry as { transientWaitsMs: number[] }).transientWaitsMs, [300_000, 900_000, 1_800_000], "設定値を auto.started に残す");

  // maxPerRun: 同じ起動の中で再試行の総数が上限に達したら、原因ごとの上限の前でも止まる
  const { root: r2, config: c2 } = makeRoot();
  enterFix(r2);
  const capped = fake(r2, () => transient());
  const out = await runAuto(r2, zoned(c2), { executor: capped.executor, sleep: recordingSleep().sleep, retry: { transient: 10, maxPerRun: 2 } });
  assert.equal(out.condition, "A14");
  assert.match(out.line, /起動あたりの再試行上限 2/);
  assert.equal(capped.calls.length, 3);

  // 回復すれば続く（2回目で成功）
  const { root: r3, config: c3 } = makeRoot();
  enterFix(r3);
  const recovers = fake(r3, (req, call) => (call === 1 ? transient() : produce(r3, req.step.id, RESULT_OF[req.step.id])));
  const ok = await runAuto(r3, zoned(c3), { executor: recovers.executor, sleep: recordingSleep().sleep });
  assert.equal(ok.condition, "A2");
  assert.equal(ok.executed[0].retries, 1, "再試行は予算に数えず、行に残す");
  assert.equal(ok.executed.length, 2);
});

// Test 212 — 組み立て失敗（A15）は再試行しない・4。failureKind の無い失敗も推測で再試行しない。
test("212: a prompt assembly error exits 4 (A15); an unclassified failure is not retried", async () => {
  const { root, config } = makeRoot();
  enterFix(root);
  const assembly = fake(root, () => {
    throw new PromptAssemblyError("skills/fix/SKILL.md が無い");
  });
  const r = await runAuto(root, zoned(config), { executor: assembly.executor });
  assert.equal(r.condition, "A15");
  assert.equal(r.exitCode, 4);
  assert.match(r.line, /executor 失敗\(assembly\) fix: skills\/fix\/SKILL\.md が無い/);
  assert.deepEqual(assembly.calls, ["fix"]);

  const unclassified = fake(root, () => ({ ok: false, outputs: [], error: "?" }));
  const u = await runAuto(root, zoned(config), { executor: unclassified.executor });
  assert.equal(u.condition, "A12");
  assert.match(u.line, /unclassified/);
  assert.deepEqual(unclassified.calls, ["fix"]);
});

// ---------------------------------------------------------------------------------------------
// 無進行（終了コード 5）: #9 #10 と A19

// Test 213 — #9: executor が status を書かない（stale）→ 5。**無限に回らない**（engine.ts の M4 申し送りの固定点）。
test("213: a stale status after exec stops with 5 (A17) instead of spinning (#9)", async () => {
  const { root, config } = makeRoot();
  setStep(root, "improve-check", { lastCompletedStep: "fix", fixAttempts: 1 });
  writeStatus(root, { step: "fix", result: "fixed", reason: "遷移元の宣言" });
  const before = stateText(root);
  const { executor, calls } = fake(root, () => ({ ok: true, outputs: [] })); // 何も書かない

  const r = await runAuto(root, zoned(config), { executor });
  assert.equal(r.condition, "A17");
  assert.equal(r.exitCode, AUTO_EXIT.noProgress);
  assert.match(r.line, /current-status.json が前ステップ "fix" の宣言のまま/);
  assert.deepEqual(calls, ["improve-check"], "1回で止まる");
  assert.equal(stateText(root), before);
});

// Test 214 — #10: run の結果で state が進まない（注入）→ 5（A18）。起動中に state が外から変わった → 5（A19）。
test("214: an iteration that leaves state unchanged stops with 5 (A18); state changed underneath stops with 5 (A19) (#10)", async () => {
  const { root, config } = makeRoot();
  enterFix(root);
  const { executor } = fake(root);
  const r = await runAuto(root, zoned(config), { executor, run: () => ({ kind: "nothing", message: "nothing to do" }) });
  assert.equal(r.condition, "A18");
  assert.equal(r.exitCode, 5);
  assert.match(r.line, /fix の反復で状態が変わらなかった/);

  // exec の最中に別の誰かが state を動かした（承認待ちにした）
  const { root: r2, config: c2 } = makeRoot();
  enterFix(r2);
  const meddled = fake(r2, (req) => {
    const out = produce(r2, req.step.id, "fixed");
    updateState(r2, { pendingApproval: "review" });
    return out;
  });
  const m = await runAuto(r2, zoned(c2), { executor: meddled.executor });
  assert.equal(m.condition, "A19");
  assert.equal(m.exitCode, 5);
  assert.match(m.line, /state が起動中に変わった/);
});

// ---------------------------------------------------------------------------------------------
// 予算（終了コード 3）: #11 と導出

// Test 215 — #11: 予算 1 で起動すると2本目の前で 3。既定の予算は workflow.yaml から導出して 8。
test("215: budget 1 stops before the second step with 3 (A11); the default budget is derived as 8 (#11)", async () => {
  const { root, config } = makeRoot();
  const cfg = zoned(config);
  enterFix(root);
  const { executor, calls } = fake(root);

  const r = await runAuto(root, cfg, { executor, maxSteps: 1 });
  assert.equal(r.condition, "A11");
  assert.equal(r.exitCode, AUTO_EXIT.budget);
  assert.match(r.line, /予算超過: 1\/1/);
  assert.deepEqual(calls, ["fix"]);
  assert.equal(readState(root).currentStep, "improve-check", "1本目は完了している");

  const derived = deriveAutoBudget(cfg);
  assert.equal(derived.total, 8);
  assert.deepEqual(derived.breakdown, [
    { step: "implementation", count: 1 },
    { step: "review", count: 1 },
    { step: "fix", count: 3 },
    { step: "improve-check", count: 3 }
  ]);
  // 上書きの優先: --max-steps > settings.autoMaxSteps > 導出。不正な値は黙って既定へ落とさない
  const withSetting = { ...cfg, settings: { ...cfg.settings, autoMaxSteps: 5 } };
  assert.equal(resolveAutoBudget(withSetting).total, 5);
  assert.equal(resolveAutoBudget(withSetting, 2).total, 2);
  assert.equal(resolveAutoBudget(cfg).source, "derived");
  assert.throws(() => resolveAutoBudget(cfg, 0), EngineError);
  assert.throws(() => resolveAutoBudget(cfg, Number("abc")), EngineError);
  assert.throws(() => resolveAutoBudget({ ...cfg, settings: { ...cfg.settings, autoMaxSteps: "8" } }), EngineError);
  assert.throws(() => resolveAutoRetry({ ...cfg, settings: { ...cfg.settings, autoRetry: { transientt: 3 } } }), /not a known key/);
  assert.equal(resolveAutoRetry({ ...cfg, settings: { ...cfg.settings, autoRetry: { idleWaitMs: 1000 } } }).idleWaitMs, 1000);
});

// ---------------------------------------------------------------------------------------------
// 構造検査（終了コード 1）: #16

// Test 216 — #16: retryPolicy を通らない循環を区間へ注入すると、走らせる前に起動拒否（A24・1）。
test("216: a zone cycle that bypasses retryPolicy is refused before anything runs (A24) (#16)", async () => {
  const { root, config } = makeRoot();
  assert.equal(findUnboundedCycle(zoned(config)), null, "出荷する形の区間には無い（唯一の循環 fix ⇄ improve-check は fix の retryPolicy を通る）");

  const noPolicy = zoned(config, (s) => {
    const { retryPolicy: _dropped, ...fix } = s.fix;
    s.fix = fix as typeof s.fix;
  });
  assert.deepEqual(findUnboundedCycle(noPolicy), ["fix", "improve-check", "fix"]);

  enterFix(root);
  const { executor, calls } = fake(root);
  const r = await runAuto(root, noPolicy, { executor });
  assert.equal(r.condition, "A24");
  assert.equal(r.exitCode, AUTO_EXIT.refused);
  assert.match(r.line, /retryPolicy を通らない循環がある: fix → improve-check → fix/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(autoLockFile(root)), false, "構造が壊れている設定ではロックも取らない");

  // ゲートを外した research に auto: true を付けた場合（設計 課題A の補足）: 自己循環を拒否する
  const researchLoop = zoned(config, (s) => {
    const { approval: _gate, ...research } = s.research;
    s.research = { ...(research as typeof s.research), executor: "claude", auto: true };
  });
  assert.deepEqual(findUnboundedCycle(researchLoop), ["research", "research"]);
  // ゲートがあれば辺を出さない（承認待ちで必ず止まる）ので循環にならない
  assert.equal(findUnboundedCycle(zoned(config, (s) => void (s.research = { ...s.research, executor: "claude", auto: true }))), null);
});

// ---------------------------------------------------------------------------------------------
// 記録と表示: #20・status --summary・宣言のローダー

// Test 217 — #20: 表示・`auto.*` イベントに生 session ID（UUID 形）が出ない。メッセージは 200 字で切る。
test("217: auto.* events and reporter output never carry a raw session id (#20)", async () => {
  const { root, config } = makeRoot();
  enterFix(root);
  const RAW = "0199a8c2-7f3e-4b1d-9c55-3e2f1a0b9d7e";
  const { executor } = fake(root, () => transient(`claude: session ${RAW} overloaded ${"x".repeat(400)}`));
  const shown: string[] = [];
  const r = await runAuto(root, zoned(config), {
    executor,
    sleep: recordingSleep().sleep,
    reporter: { retrying: (i) => void shown.push(i.message) }
  });
  assert.equal(r.condition, "A14");
  const events = JSON.stringify(autoEvents(root));
  assert.doesNotMatch(events, new RegExp(RAW));
  assert.doesNotMatch(r.line, new RegExp(RAW));
  assert.doesNotMatch(shown.join("\n"), new RegExp(RAW));
  assert.match(events, /<id:9d7e>/, "末尾識別子だけを残す");
  const retry = autoEvents(root).find((e) => e.event === "auto.retry")!;
  assert.ok(String(retry.message).length <= 201, "先頭 200 字");
});

// Test 218 — `aiw status --summary` の Observed 側に直近の auto 起動が載る（現在のタスクの窓に auto.stopped があるとき）。
test("218: status --summary shows the last auto run of the current task", async () => {
  const { root, config } = makeRoot();
  enterFix(root);
  assert.equal(buildObserved(root).lastAuto, undefined, "auto が走っていなければキーごと無い");

  const { executor } = fake(root);
  await runAuto(root, zoned(config), { executor });
  const observed = buildObserved(root);
  assert.equal(observed.lastAuto?.condition, "A2");
  assert.equal(observed.lastAuto?.exitCode, 0);
  assert.deepEqual(
    observed.lastAuto?.executed.map((e) => e.step),
    ["fix", "improve-check"]
  );
  const text = formatSummary(buildSummary(root), observed);
  assert.match(text, /Last auto:\s+clipboard \(A2, exit 0\) at reflection/);
  assert.match(text, /executed: fix → improve-check \/ improve-check → reflection/);
});

// Test 219 — 宣言 `steps.<id>.auto`: 真偽値以外はロード時に落とす。clipboard のステップでは効かないキーとして列挙する
// （BL-219 の表の続き。ロード時エラーにはしない = executor の1行を戻しても読める・不変条件5）。
test("219: steps.<id>.auto must be boolean, and is listed as ineffective on clipboard steps", () => {
  const load = (edit: (y: string, eol: string) => string) => {
    const { root } = makeRoot();
    const file = rootPaths(root).workflowYaml;
    const text = readFileSync(file, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const edited = edit(text, eol);
    assert.notEqual(edited, text, "書き換えのアンカーが assets に見つかること");
    writeFileSync(file, edited, "utf8");
    return () => loadWorkflow(root);
  };
  const fixHead = (eol: string) => `  fix:${eol}    role: codex${eol}`;

  const asCodex = load((y, eol) => y.replace(fixHead(eol), `${fixHead(eol)}    executor: codex${eol}    auto: true${eol}`))();
  assert.equal(asCodex.steps.fix.auto, true);
  assert.equal(asCodex.ineffectiveStepKeys, undefined, "codex のステップでは効く");

  const rolledBack = load((y, eol) => y.replace(fixHead(eol), `${fixHead(eol)}    auto: true${eol}`))();
  assert.equal(rolledBack.steps.fix.executor, "clipboard");
  assert.match(rolledBack.ineffectiveStepKeys?.join("\n") ?? "", /steps\.fix\.auto は executor "clipboard" では効かない/);

  const falseOnClipboard = load((y, eol) => y.replace(fixHead(eol), `${fixHead(eol)}    auto: false${eol}`))();
  assert.equal(falseOnClipboard.ineffectiveStepKeys, undefined, "false は何も宣言していないのと同じ");

  assert.throws(load((y, eol) => y.replace(fixHead(eol), `${fixHead(eol)}    auto: "yes"${eol}`)), /declares auto: "yes"\. Allowed: true or false/);
});

// ---------------------------------------------------------------------------------------------
// 実物の CLI（終了コードと --json）

function cli(root: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [path.join(PKG, "node_modules", "tsx", "dist", "cli.js"), path.join(PKG, "src", "cli.ts"), "--root", root, "auto", ...args],
    { encoding: "utf8", windowsHide: true, timeout: 120_000, cwd: PKG }
  );
  assert.equal(r.error, undefined, `aiw auto を起動できない: ${r.error?.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------------------------
// drive の auto モード（2026-09-25 の決定: `a` で入る・auto: true のステップに限る・人の番で drive へ戻る）

/**
 * 検証用のステップを2つ足した root。どちらも codex を宣言するが**プロンプトも Skill も持たない**:
 * - `probe` … auto: true なし（`a` を断る側）。断った後に clipboard へ落ちても "no-prompt" で OS のクリップボードに書かない
 * - `probe-auto` … auto: true（`a` で合流する側）。テストの root には隔離 CODEX_HOME が無いので、
 *   codex executor は**起動前に** permanent で返す（実物の codex を起動しない）
 */
function makeProbeRoot() {
  const ctx = makeRoot();
  const file = rootPaths(ctx.root).workflowYaml;
  const doc = parseYaml(readFileSync(file, "utf8"));
  const probe = { role: "codex", executor: "codex", inputs: [], outputs: [], transitions: { done: { next: "complete" } } };
  doc.steps.probe = probe;
  doc.steps["probe-auto"] = { ...probe, auto: true };
  writeFileSync(file, stringifyYaml(doc), "utf8");
  return { ...ctx, config: loadConfig(ctx.root) };
}

function driveCli(root: string, input: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [path.join(PKG, "node_modules", "tsx", "dist", "cli.js"), path.join(PKG, "src", "cli.ts"), "--root", root, "drive"],
    { input, encoding: "utf8", windowsHide: true, timeout: 120_000, cwd: PKG }
  );
  assert.equal(r.error, undefined, `aiw drive を起動できない: ${r.error?.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Test 230 — `a` は auto: true のステップに限る。区間の規則は auto と同じ関数（autoIneligibility）で、
// drive から入っても区間外（research など）は無人にしない。
test("230: drive's `a` is refused on a step without auto: true, by the same rule auto uses", () => {
  const { root, config } = makeProbeRoot();
  assert.equal(autoIneligibility(config.steps.probe), "out-of-zone");
  assert.equal(autoIneligibility(config.steps["probe-auto"]), null);
  assert.equal(autoIneligibility(config.steps.reflection), "clipboard");

  setStep(root, "probe");
  const out = driveCli(root, "a\n");
  assert.match(out.stdout, /\[y=実行 \/ n=クリップボードへ \/ a=ここから auto（人の番で drive に戻る）\]/);
  assert.match(out.stdout, /"probe" は無人対象外です（auto: true の宣言が無い）。y\/n で進めてください。/);
  assert.doesNotMatch(out.stdout, /auto モードに入ります/);
  assert.equal(autoEvents(root).length, 0, "auto は起動しない");
  assert.equal(existsSync(autoLockFile(root)), false, "ロックも取らない");
});

// Test 231 — `a` で auto モードに入る。ロックは `a` の瞬間に取る（drive はそれまでロックを見ない）。
// **異常停止**（ここでは起動拒否 A23 と executor 失敗 A12）なら、auto の終了コードのまま drive も終わり、質問へ戻らない。
test("231: drive's `a` enters auto on the spot: the lock is taken at that moment, and an abnormal stop ends drive", () => {
  const { root } = makeProbeRoot();

  // 別の auto がロックを持っている。drive は `a` までロックを見ないので、halt の対話はふだんどおり出る
  writeFileSync(autoLockFile(root), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), runId: "auto-held" }), "utf8");
  setStep(root, "probe-auto", { status: "halted", haltedReason: "validation-failed" });
  const halted = driveCli(root, "n\n");
  assert.match(halted.stdout, /HALTED \(validation-failed\) at "probe-auto"/);
  assert.doesNotMatch(halted.stdout + halted.stderr, /別の aiw auto が実行中/);

  // `a` の瞬間にロックを取りに行き、拒否される（A23・終了コード 1）。他人のロックは消さない
  setStep(root, "probe-auto");
  const refused = driveCli(root, "a\n");
  assert.match(refused.stdout, /auto モードに入ります/);
  assert.match(refused.stdout, /別の aiw auto が実行中（pid \d+/);
  assert.match(refused.stdout, /drive を終了します/);
  assert.equal(refused.status, 1);
  assert.ok(existsSync(autoLockFile(root)));
  assert.ok(autoEvents(root).some((e) => e.event === "auto.refused" && e.condition === "A23"));

  // ロックが空いていれば auto として走り、auto の停止（ここでは隔離 home が無いので A12・終了コード 4）で drive も終わる
  rmSync(autoLockFile(root));
  const joined = driveCli(root, "a\ny\ny\n"); // 余分な y は、drive が合流後も質問を続けていないかの見張り
  assert.equal(joined.status, AUTO_EXIT.execFailed);
  assert.match(joined.stdout, /▶ \[1\/\d+\] probe-auto/);
  assert.match(joined.stdout, /executor 失敗\(permanent\) probe-auto/);
  assert.equal(joined.stdout.split("[y=実行 / n=クリップボードへ").length - 1, 1, "異常停止の後は drive の質問へ戻らない");
  assert.doesNotMatch(joined.stdout, /人の番なので drive に戻ります/);
  const stopped = autoEvents(root).filter((e) => e.event === "auto.stopped");
  assert.equal(stopped.at(-1)?.condition, "A12");
  assert.equal(existsSync(autoLockFile(root)), false, "終わればロックを外す");
  assert.equal(readState(root).currentStep, "probe-auto", "state は変わらない");
});

// Test 232 — auto が止まった後に drive へ戻るか（returnsToDrive）。**人の番（終了コード 0）だけ戻る**。
// 承認ゲート（review ③ / research ②）・clipboard・区間外・完了では drive がふだんどおり聞き、承認するのは人。
// halt・予算・executor 失敗・無進行・中断・起動拒否では戻らない（drive も終わる）。
// ⚠️ 戻る側をサブプロセスの drive で通すには無人ステップを**成功**させる必要があるが、executor の起動コマンドは
//    node_modules に固定で偽物に差し替えられない。そこで判断をこの純関数に置いて表で固定し、drive はそれに従うだけにした。
//    戻った先は drive に既にある分岐（承認ゲートは Test 190 など）。戻らない側の実物は Test 231。
test("232: drive resumes asking only when auto stops on the human's turn (exit 0)", async () => {
  const table: Array<[number, boolean]> = [
    [AUTO_EXIT.humanTurn, true],
    [AUTO_EXIT.refused, false],
    [AUTO_EXIT.halted, false],
    [AUTO_EXIT.budget, false],
    [AUTO_EXIT.execFailed, false],
    [AUTO_EXIT.noProgress, false],
    [AUTO_EXIT.interrupted, false]
  ];
  for (const [exitCode, expected] of table) {
    assert.equal(returnsToDrive({ exitCode: exitCode as (typeof AUTO_EXIT)[keyof typeof AUTO_EXIT] }), expected, `exit ${exitCode}`);
  }
  assert.equal(table.length, Object.keys(AUTO_EXIT).length, "終了コードをすべて表に載せた");

  // 実際の停止で確かめる: 承認ゲート（review）・clipboard（reflection）・区間外（research）は人の番で、戻る
  const { root, config } = makeRoot();
  const cfg = zoned(config, (s) => {
    s.research = { ...s.research, executor: "claude" };
  });
  const { executor } = fake(root);
  setStep(root, "implementation");
  writeIn(root, "context-package.md", "# Files\n## Modify\n- `x.ts`\n");
  const gate = await runAuto(root, cfg, { executor });
  assert.equal(gate.condition, "A1");
  assert.equal(gate.step, "review");
  assert.equal(returnsToDrive(gate), true, "review の承認ゲートでは drive に戻って人に聞く");
  assert.equal(readState(root).pendingApproval, "review", "auto は承認しない");
  setStep(root, "research");
  assert.equal(returnsToDrive(await runAuto(root, cfg, { executor })), true, "research（区間外）でも戻る");
  setStep(root, "fix", { status: "halted", haltedReason: "escalation" });
  assert.equal(returnsToDrive(await runAuto(root, cfg, { executor })), false, "halt では戻らない");
});

// Test 220 — 実物の `aiw auto` の終了コード: 人の番 0（clipboard の task-planning ではクリップボードに触れる前に止まる）/
// halt 2 / 同時実行 1 / 不明 1。`--json` は stdout の最後の1行。
test("220: the real `aiw auto` exits 0 / 2 / 1 and prints one JSON line with --json", () => {
  const { root } = makeRoot();

  const human = cli(root, "--json");
  assert.equal(human.status, 0);
  const json = JSON.parse(human.stdout.trim().split(/\r?\n/).pop()!);
  assert.equal(json.stop, "clipboard");
  assert.equal(json.condition, "A2");
  assert.equal(json.step, "task-planning");
  assert.equal(json.exitCode, 0);
  assert.deepEqual(json.executed, []);
  assert.match(human.stderr, /人の番: task-planning は clipboard/, "--json のとき人間向けの表示は stderr");

  setStep(root, "fix", { status: "halted", haltedReason: "escalation" });
  const halted = cli(root, "--quiet");
  assert.equal(halted.status, 2);
  assert.match(halted.stdout, /既に HALT\(escalation\)/);

  setStep(root, "fix");
  writeFileSync(autoLockFile(root), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), runId: "auto-held" }), "utf8");
  const locked = cli(root);
  assert.equal(locked.status, 1);
  assert.match(locked.stdout, /別の aiw auto が実行中（pid \d+/);
  assert.ok(existsSync(autoLockFile(root)), "他人のロックは消さない");

  setStep(root, "not-a-step");
  const bad = cli(root, "--max-steps", "0");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--max-steps must be a positive integer/);
});
