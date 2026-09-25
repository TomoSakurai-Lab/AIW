// `aiw auto`（M5）: 承認ゲートの後の無人区間を、人間の代わりに exec → run と叩き続ける。
//
// **正本は docs/design-auto.md。** 停止条件の表（課題A: A1〜A25）・予算（課題C）・再試行（課題D）・
// 安全弁（課題H）・終了コード（課題G）はすべてそこで決めたもので、ここはその実装。
//
// auto は**人間の代行**であり、判定には一切関与しない（前提5）。したがってここでは次のことを**しない**:
//   - 承認・却下を呼ばない（ゲートでは止まって人を呼ぶ）
//   - halt を resume しない（resume するのはチェックポイント pendingTransition だけ。drive と同じ）
//   - diff-scope の baseline を取り直さない（エンジン専用の captureIfAbsent 以外の経路を持たない）
//   - `report` 宣言の違反を停止へ格上げしない
//   - state.json を自分で書かない（書くのは run / resume の既存経路だけ）
// Test 205 がこの import を監視している。
//
// **永続する状態を持たない**（課題B）。毎反復で state.json を読み直し、予算と再試行の回数は
// この起動の間だけメモリに置く。再起動でゼロに戻るのは意図どおり（再起動は人間の判断）。
//
// 表示はしない。CLI が `AutoReporter` を通して受け取り、整形する（「エンジンは結果を返す、CLI が表示する」）。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PipelineOutcome } from "./completion.js";
import { classifySituation, EngineError, execStep, resume, runStep, staleStatusStep } from "./engine.js";
import { appendEvent } from "./eventLog.js";
import type { ExecutorProgress, ExecutorResult, StepExecutor } from "./executors/types.js";
import { rootPaths } from "./paths.js";
import { PromptAssemblyError } from "./promptAssembly.js";
import { readState } from "./state.js";
import type { EngineState, HaltedReason, WorkflowConfig, WorkflowStep } from "./types.js";

// ---------------------------------------------------------------------------------------------
// 停止（課題A・課題G）

/** `--json` の `stop`。区別したいスクリプトはこれを読む（終了コード 0 は「人の番」で統一している） */
export type AutoStopKind =
  | "gate"
  | "clipboard"
  | "out-of-zone"
  | "complete"
  | "halted"
  | "budget"
  | "exec-failed"
  | "no-progress"
  | "interrupted"
  | "refused";

/** 終了コード（課題G）。既存の 0 / 1 / 2 の意味は変えない */
export const AUTO_EXIT = {
  humanTurn: 0,
  refused: 1,
  halted: 2,
  budget: 3,
  execFailed: 4,
  noProgress: 5,
  interrupted: 130
} as const;
export type AutoExitCode = (typeof AUTO_EXIT)[keyof typeof AUTO_EXIT];

export type AutoStop = {
  stop: AutoStopKind;
  /** 設計文書の停止条件の番号（A1〜A25）。表と突き合わせるための鍵 */
  condition: string;
  step: string | null;
  /** 停止理由の1行（設計文書 課題A の「表示する1行」） */
  line: string;
  exitCode: AutoExitCode;
};

// ---------------------------------------------------------------------------------------------
// 区間・予算・構造検査（課題A の A3・課題C・課題H）

/** 無人区間のステップ: `auto: true` を宣言し、かつ clipboard でないもの（clipboard は A2 で必ず止まる） */
export function autoZone(config: WorkflowConfig): WorkflowStep[] {
  return Object.values(config.steps).filter((s) => s.auto === true && s.executor !== "clipboard");
}

/**
 * 区間の中で auto が1回の起動でたどりうる辺。
 * **承認ゲートを持つステップからは辺を出さない**（run の結果は必ず承認待ちになり、auto はそこで止まる・A1）。
 */
function zoneEdges(config: WorkflowConfig, include: (step: WorkflowStep) => boolean = () => true): Map<string, string[]> {
  const zone = new Set(autoZone(config).filter(include).map((s) => s.id));
  const edges = new Map<string, string[]>();
  for (const id of zone) {
    const step = config.steps[id];
    const next = step.approval ? [] : Object.values(step.transitions).map((t) => t.next);
    edges.set(id, [...new Set(next.filter((n) => zone.has(n)))]);
  }
  return edges;
}

/** from から1辺以上でたどり着ける頂点（from 自身は循環があるときだけ含む） */
function reachableFrom(edges: Map<string, string[]>, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(from) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    stack.push(...(edges.get(id) ?? []));
  }
  return seen;
}

/**
 * 起動時の構造検査（課題H）: 区間の循環が**すべて retryPolicy を持つステップを通る**ことを確かめる。
 *
 * 「retryPolicy を持たないステップだけでできた循環がある」⇔「retryPolicy のステップを取り除いた部分グラフに循環がある」
 * なので、その部分グラフで循環を1つ探して返す。無ければ null。
 * 将来 workflow.yaml に循環が足されたとき、**走らせる前に**止まる（A24・終了コード 1）。
 */
export function findUnboundedCycle(config: WorkflowConfig): string[] | null {
  const edges = zoneEdges(config, (s) => !s.retryPolicy);
  const state = new Map<string, "visiting" | "done">();
  const pathStack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, "visiting");
    pathStack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === "visiting") {
        return [...pathStack.slice(pathStack.indexOf(next)), next];
      }
      if (!state.has(next)) {
        const found = visit(next);
        if (found) {
          return found;
        }
      }
    }
    pathStack.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of edges.keys()) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export type AutoBudget = {
  total: number;
  source: "derived" | "settings" | "cli";
  derived: number;
  /** 導出の内訳（`予算 8 = implementation 1 + review 1 + fix 3 + improve-check 3`） */
  breakdown: Array<{ step: string; count: number }>;
};

/**
 * 予算の既定値を workflow.yaml から導出する（課題C）。
 *
 *   予算 = Σ（区間内のステップ）  retryPolicy を持つステップを含む循環の上にある → maxRetries + 1
 *                                 それ以外                                    → 1
 *
 * **正常な経路では当たらない値**にするのが設計意図。当たったら「ワークフローのモデル化から外れた経路を通った」。
 * 正常な経路で当たる予算は escalation と並ぶ第2の判定になり、前提5 に反する。
 */
export function deriveAutoBudget(config: WorkflowConfig): { total: number; breakdown: Array<{ step: string; count: number }> } {
  const edges = zoneEdges(config);
  const reach = new Map<string, Set<string>>();
  for (const id of edges.keys()) {
    reach.set(id, reachableFrom(edges, id));
  }
  const breakdown = [...edges.keys()].map((id) => {
    if (!reach.get(id)!.has(id)) {
      return { step: id, count: 1 };
    }
    // 同じ循環の上にある（互いに到達できる）ステップのうち、retryPolicy を持つものの上限
    const members = [...edges.keys()].filter((other) => other === id || (reach.get(id)!.has(other) && reach.get(other)!.has(id)));
    const limits = members.map((m) => config.steps[m].retryPolicy?.maxRetries).filter((n): n is number => typeof n === "number");
    return { step: id, count: limits.length > 0 ? Math.max(...limits) + 1 : 1 };
  });
  return { total: breakdown.reduce((sum, b) => sum + b.count, 0), breakdown };
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new EngineError(`${label} must be a positive integer (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/** 予算を決める: `--max-steps` > `settings.autoMaxSteps` > 導出値。不正な値は黙って既定へ落とさず起動を拒否する */
export function resolveAutoBudget(config: WorkflowConfig, cliMaxSteps?: number): AutoBudget {
  const { total: derived, breakdown } = deriveAutoBudget(config);
  if (cliMaxSteps !== undefined) {
    return { total: positiveInteger(cliMaxSteps, "--max-steps"), source: "cli", derived, breakdown };
  }
  if (config.settings.autoMaxSteps !== undefined) {
    return { total: positiveInteger(config.settings.autoMaxSteps, "settings.autoMaxSteps"), source: "settings", derived, breakdown };
  }
  return { total: derived, source: "derived", derived, breakdown };
}

// ---------------------------------------------------------------------------------------------
// 再試行（課題D）

export type AutoRetrySettings = {
  /** 総上限タイムアウト（timeoutKind: total）の再試行回数。**即時** */
  totalTimeout: number;
  /** 無進行タイムアウト（timeoutKind: idle）の再試行回数 */
  idleTimeout: number;
  /** 無進行タイムアウトの再試行前の待機。止まった原因が残ったまま同じ壁へ即座に再突入しないため（#6 の承認時の修正） */
  idleWaitMs: number;
  /** その他の transient（容量不足・rate limit・ネットワーク・不明）の再試行回数 */
  transient: number;
  /** その他の transient の待機（n 回目に n 番目。足りなければ最後の値） */
  transientWaitsMs: number[];
  /** 1回の起動での再試行の総数の上限（予算 8 × 再試行 3 の最悪値を無人で払わせない） */
  maxPerRun: number;
};

export const DEFAULT_AUTO_RETRY: Readonly<AutoRetrySettings> = {
  totalTimeout: 1,
  idleTimeout: 1,
  idleWaitMs: 300_000,
  transient: 3,
  transientWaitsMs: [300_000, 900_000, 1_800_000],
  maxPerRun: 6
};

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new EngineError(`${label} must be a non-negative integer (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/** `settings.autoRetry` を既定値へ重ねる。不正な値・未知のキーは起動を拒否する（黙って既定へ落とさない） */
export function resolveAutoRetry(config: WorkflowConfig, override: Partial<AutoRetrySettings> = {}): AutoRetrySettings {
  const raw = config.settings.autoRetry ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EngineError(`settings.autoRetry must be a mapping (got ${JSON.stringify(raw)}).`);
  }
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_AUTO_RETRY)) {
      throw new EngineError(`settings.autoRetry.${key} is not a known key. Allowed: ${Object.keys(DEFAULT_AUTO_RETRY).join(", ")}.`);
    }
  }
  const merged = { ...DEFAULT_AUTO_RETRY, ...(raw as Partial<AutoRetrySettings>), ...override };
  for (const key of ["totalTimeout", "idleTimeout", "idleWaitMs", "transient", "maxPerRun"] as const) {
    nonNegativeInteger(merged[key], `settings.autoRetry.${key}`);
  }
  if (!Array.isArray(merged.transientWaitsMs) || merged.transientWaitsMs.length === 0) {
    throw new EngineError(`settings.autoRetry.transientWaitsMs must be a non-empty list.`);
  }
  merged.transientWaitsMs.forEach((ms, i) => nonNegativeInteger(ms, `settings.autoRetry.transientWaitsMs[${i}]`));
  return { ...merged, transientWaitsMs: [...merged.transientWaitsMs] };
}

export type RetryCause = "total-timeout" | "idle-timeout" | "transient";

/**
 * 失敗した exec の再試行上の分類。
 *
 * ⚠️ **auto 自身の中断はここへ来る前に除く**（呼び出し側が自分の signal を見る）。
 * 中断された executor も `transient` を返すので、結果からは人間の Ctrl+C と容量不足が区別できない（設計 §6）。
 * ⚠️ total / idle は `meta.timeoutKind`（エンジンの watchdog が書く）で分ける。**理由文字列を解析しない。**
 * ⚠️ failureKind が無い失敗は分類できないので再試行しない（「transient と言われていないもの」を transient と推測しない）。
 */
export function classifyExecFailure(result: ExecutorResult): RetryCause | "permanent" | "unclassified" {
  const kind = (result.meta as { timeoutKind?: unknown } | undefined)?.timeoutKind;
  if (kind === "total") {
    return "total-timeout";
  }
  if (kind === "idle") {
    return "idle-timeout";
  }
  if (result.failureKind === "transient") {
    return "transient";
  }
  return result.failureKind === "permanent" ? "permanent" : "unclassified";
}

/** 中断可能な待機。signal が立てば即座に戻る */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => done();
    const timer = setTimeout(() => done(), ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Event Log・表示へ出す失敗メッセージ: 先頭 200 字、UUID 形の文字列は伏せる（不変条件6）。
 *
 * ⚠️ 設計文書は `redactSession` を通すとしているが、生の session ID（SessionSecret）は executor の中にしか無く、
 * auto には渡らない（型で分離してある）。executor は result.error を作る時点で既に redactSession を通している。
 * ここではその上に、session ID の形（UUID）を一律に伏せる網を重ねる。
 */
export function sanitizeMessage(text: string | undefined): string {
  const masked = (text ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `<id:${m.slice(-4)}>`);
  return masked.length > 200 ? `${masked.slice(0, 200)}…` : masked;
}

// ---------------------------------------------------------------------------------------------
// 同時実行のロック（課題B）

export type AutoLock = { pid: number; startedAt: string; runId: string };

export function autoLockFile(root: string): string {
  return path.join(rootPaths(root).runsDir, "auto.lock");
}

/** pid のプロセスが生きているか。EPERM は「存在するが触れない」なので生きている */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `runs/auto.lock` を取る。**相互排他のためのもので、進行の記録ではない**（進行は state.json から導く）。
 *
 * - 取れなければ `{ ok: false, holder }`（A23）
 * - 持ち主の pid が既に無ければ古いロックとみなして引き継ぎ、`takenOver` で知らせる
 * - 読めないロック（書きかけ・壊れている）は安全側で「使用中」とみなす
 *
 * ⚠️ drive や手動の `aiw exec` はこのロックを見ない（既存の挙動を変えない）。
 */
export function acquireAutoLock(
  root: string,
  lock: AutoLock,
  isAlive: (pid: number) => boolean = processAlive
): { ok: true; takenOver?: AutoLock } | { ok: false; holder: AutoLock | null } {
  const file = autoLockFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const tryCreate = (): boolean => {
    try {
      writeFileSync(file, `${JSON.stringify(lock)}\n`, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  };
  if (tryCreate()) {
    return { ok: true };
  }
  let holder: AutoLock | null = null;
  try {
    holder = JSON.parse(readFileSync(file, "utf8")) as AutoLock;
  } catch {
    return { ok: false, holder: null };
  }
  if (typeof holder?.pid !== "number" || isAlive(holder.pid)) {
    return { ok: false, holder };
  }
  rmSync(file, { force: true });
  return tryCreate() ? { ok: true, takenOver: holder } : { ok: false, holder: null };
}

/** 自分のロックだけを外す（別の起動が引き継いだロックは消さない） */
export function releaseAutoLock(root: string, runId: string): void {
  const file = autoLockFile(root);
  if (!existsSync(file)) {
    return;
  }
  try {
    const held = JSON.parse(readFileSync(file, "utf8")) as AutoLock;
    if (held.runId === runId) {
      rmSync(file, { force: true });
    }
  } catch {
    // 読めないロックは自分のものと言い切れないので残す（次の起動が「使用中」と表示する）
  }
}

// ---------------------------------------------------------------------------------------------
// ループ

/** 反復の前後で比べる state の指紋（A18）。updatedAt は含めない（書いただけで変わる） */
export function stateFingerprint(state: EngineState): string {
  return JSON.stringify([
    state.currentStep,
    state.status,
    state.fixAttempts,
    state.pendingApproval,
    state.pendingTransition,
    state.lastCompletedStep
  ]);
}

/** 見出しに出す executor / model / effort（requested。実際の値は Event Log の exec.* にある） */
export function describeExecutor(step: WorkflowStep, config: WorkflowConfig): { executor: string; model: string | null; effort: string | null } {
  const s = config.settings;
  if (step.executor === "codex") {
    return { executor: "codex", model: typeof s.codexModel === "string" ? s.codexModel : null, effort: null };
  }
  if (step.executor === "claude") {
    const model = step.model ?? (typeof s.claudeModel === "string" ? s.claudeModel : null);
    const effort = step.effort ?? (typeof s.claudeEffort === "string" ? s.claudeEffort : null);
    return { executor: "claude", model, effort };
  }
  return { executor: step.executor, model: null, effort: null };
}

/** この起動で実行したステップ1件（停止サマリの1行・`auto.stopped` の `executed`） */
export type AutoExecution = {
  step: string;
  executor: string;
  modelRequested: string | null;
  modelObserved: string | null;
  /** exec（再試行と待機を含む）+ run の所要 */
  durationMs: number;
  retries: number;
  /** 結果の短い表記: `→ review` / `awaiting-approval` / `HALT(escalation)` / `exec-failed(transient ×4)` など */
  result: string;
  /** 停止に格上げしなかった `report` 違反（表示とサマリには出す） */
  reported: string[];
  tokens: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null } | null;
};

export type AutoReporter = {
  started?(info: { runId: string; budget: AutoBudget; retry: AutoRetrySettings; takenOver?: AutoLock }): void;
  stepStarted?(info: { index: number; budget: number; step: WorkflowStep; model: string | null; effort: string | null }): void;
  progress?(event: ExecutorProgress): void;
  retrying?(info: { step: string; cause: RetryCause; attempt: number; max: number; waitMs: number; message: string }): void;
  /** run の結果（exec → run の1サイクルの終わり） */
  outcome?(outcome: PipelineOutcome, info: { step: string; durationMs: number }): void;
  /** チェックポイントの resume の結果 */
  resumed?(outcome: PipelineOutcome): void;
};

export type AutoOptions = {
  /** `--max-steps`。settings.autoMaxSteps より優先 */
  maxSteps?: number;
  /** auto 自身の中断（Ctrl+C）。**再試行の判断はこの signal で行う**（executor の結果からは区別できない） */
  signal?: AbortSignal;
  reporter?: AutoReporter;
  // --- test seams ---
  executor?: StepExecutor;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  retry?: Partial<AutoRetrySettings>;
  run?: (root: string, config: WorkflowConfig, stepId: string) => PipelineOutcome;
  pid?: number;
  isAlive?: (pid: number) => boolean;
};

export type AutoResult = AutoStop & {
  runId: string | null;
  budget: AutoBudget | null;
  executed: AutoExecution[];
};

const HALT_CONDITION: Record<HaltedReason, string> = {
  escalation: "A5",
  "invalid-status": "A6",
  "validation-failed": "A7",
  "post-action-failed": "A8",
  "approval-rejected": "A9"
};

function haltStop(outcome: Extract<PipelineOutcome, { kind: "halted" }>): AutoStop {
  const allowed = outcome.detail?.allowed;
  const suffix = Array.isArray(allowed) && allowed.length > 0 ? `（許可: ${allowed.join(" | ")}）` : "";
  return {
    stop: "halted",
    condition: HALT_CONDITION[outcome.reason] ?? "A5-A9",
    step: outcome.step,
    line: `⛔ HALT(${outcome.reason}) ${outcome.step}: ${outcome.message}${suffix} — 人が対処 → aiw resume → aiw auto`,
    exitCode: AUTO_EXIT.halted
  };
}

function interrupted(condition: "A20" | "A22", step: string | null, note: string): AutoStop {
  return {
    stop: "interrupted",
    condition,
    step,
    line: `⏹ 中断: ${step ?? "-"}（${note}）`,
    exitCode: AUTO_EXIT.interrupted
  };
}

function refused(root: string, condition: "A23" | "A24", line: string, fields: Record<string, unknown>): AutoResult {
  appendEvent(root, "auto.refused", { condition, message: line, ...fields });
  return { stop: "refused", condition, step: null, line, exitCode: AUTO_EXIT.refused, runId: null, budget: null, executed: [] };
}

function tokensOf(result: ExecutorResult | null): AutoExecution["tokens"] {
  const usage = (result?.meta as { usage?: Record<string, number | null> } | undefined)?.usage;
  if (!usage) {
    return null;
  }
  return { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, cacheReadTokens: usage.cacheReadTokens ?? null };
}

function modelsOf(result: ExecutorResult | null, fallback: string | null): { modelRequested: string | null; modelObserved: string | null } {
  const meta = (result?.meta ?? {}) as { modelRequested?: unknown; modelObserved?: unknown };
  const observed = Array.isArray(meta.modelObserved) ? meta.modelObserved.join(",") : typeof meta.modelObserved === "string" ? meta.modelObserved : null;
  return { modelRequested: typeof meta.modelRequested === "string" ? meta.modelRequested : fallback, modelObserved: observed };
}

function outcomeLabel(outcome: PipelineOutcome): string {
  switch (outcome.kind) {
    case "transitioned":
      return `→ ${outcome.to}`;
    case "awaiting-approval":
      return "awaiting-approval";
    case "halted":
      return `HALT(${outcome.reason})`;
    case "rerun":
      return "rerun";
    case "nothing":
      return "nothing";
  }
}

/**
 * `aiw auto` の本体。毎反復で state.json を読み、判定器 classifySituation（next / drive と共有）の結果に
 * auto の方針（clipboard・区間・予算）を重ねて、exec → run を叩くか止まるかを決める。
 *
 * 毎反復の判定順（設計文書 課題A）:
 *   0 中断要求 → A20 / 1 halted → A10 / 2 承認待ち → A1 / 3 チェックポイント → resume して継続 /
 *   4 終端 → A4 / 5 未定義 → A25 / 6 clipboard → A2 / 7 区間外 → A3 / 8 予算 → A11 /
 *   9 exec（失敗なら再試行 → A12-A15）/ 10 stale status → A17（**exec の後・run の前にだけ**）/ 11 run
 */
export async function runAuto(root: string, config: WorkflowConfig, opts: AutoOptions = {}): Promise<AutoResult> {
  // 起動拒否（A24 → A23 の順: 構造が壊れている設定ではロックも取らない）
  const cycle = findUnboundedCycle(config);
  if (cycle) {
    return refused(root, "A24", `✖ auto の区間に retryPolicy を通らない循環がある: ${cycle.join(" → ")}`, { cycle });
  }
  const budget = resolveAutoBudget(config, opts.maxSteps);
  const retry = resolveAutoRetry(config, opts.retry);

  const runId = `auto-${randomUUID().slice(0, 8)}`;
  const lock = acquireAutoLock(root, { pid: opts.pid ?? process.pid, startedAt: new Date().toISOString(), runId }, opts.isAlive);
  if (!lock.ok) {
    const holder = lock.holder;
    const line = holder
      ? `✖ 別の aiw auto が実行中（pid ${holder.pid}, 開始 ${new Date(holder.startedAt).toTimeString().slice(0, 5)}）`
      : `✖ 別の aiw auto が実行中（${autoLockFile(root)} を読めない。動いていないなら消してから再実行）`;
    return refused(root, "A23", line, { holder });
  }

  try {
    appendEvent(root, "auto.started", {
      runId,
      budget: budget.total,
      budgetSource: budget.source,
      budgetDerived: budget.derived,
      budgetBreakdown: budget.breakdown,
      retry,
      ...(lock.takenOver ? { lockTakenOver: lock.takenOver } : {})
    });
    opts.reporter?.started?.({ runId, budget, retry, takenOver: lock.takenOver });

    const executed: AutoExecution[] = [];
    let result: AutoStop;
    try {
      result = await loop(root, config, opts, { runId, budget, retry, executed });
    } catch (error) {
      // 想定外の例外（A25）。CLI が `error: …` と終了コード 1 にする。ここでは記録だけ残す
      appendEvent(root, "auto.stopped", {
        runId,
        stop: "refused",
        condition: "A25",
        step: readState(root).currentStep,
        exitCode: AUTO_EXIT.refused,
        message: sanitizeMessage(error instanceof Error ? error.message : String(error)),
        executedCount: executed.length,
        budget: budget.total,
        executed
      });
      throw error;
    }
    appendEvent(root, "auto.stopped", {
      runId,
      stop: result.stop,
      condition: result.condition,
      step: result.step,
      exitCode: result.exitCode,
      message: result.line,
      executedCount: executed.length,
      budget: budget.total,
      executed
    });
    return { ...result, runId, budget, executed };
  } finally {
    releaseAutoLock(root, runId);
  }
}

type LoopContext = { runId: string; budget: AutoBudget; retry: AutoRetrySettings; executed: AutoExecution[] };

async function loop(root: string, config: WorkflowConfig, opts: AutoOptions, ctx: LoopContext): Promise<AutoStop> {
  const { signal, reporter } = opts;
  const run = opts.run ?? runStep;
  let retriesUsed = 0;

  for (let iteration = 0; ; iteration++) {
    const state = readState(root);
    if (signal?.aborted) {
      return interrupted("A20", state.currentStep, "state は変更なし。aiw auto で続きから");
    }
    const situation = classifySituation(state, config);

    if (situation.kind === "halted") {
      return {
        stop: "halted",
        condition: iteration === 0 ? "A10" : HALT_CONDITION[situation.reason ?? "escalation"] ?? "A5-A9",
        step: situation.step,
        line: `⛔ 既に HALT(${situation.reason}) ${situation.step} — auto は resume しない。直してから aiw resume`,
        exitCode: AUTO_EXIT.halted
      };
    }
    if (situation.kind === "awaiting-approval") {
      return {
        stop: "gate",
        condition: "A1",
        step: situation.step,
        line: `⏸ 承認待ち: ${situation.step} — aiw approve / aiw reject <理由>`,
        exitCode: AUTO_EXIT.humanTurn
      };
    }
    if (situation.kind === "checkpoint") {
      // postActions の途中で止まった遷移を完了させる（drive と同じ。冪等性は既存テスト 7 / 7b / 27b）
      const before = stateFingerprint(state);
      const outcome = resume(root, config);
      reporter?.resumed?.(outcome);
      if (outcome.kind === "halted") {
        return haltStop(outcome);
      }
      if (stateFingerprint(readState(root)) === before) {
        return noProgress("A18", situation.pending.from, `チェックポイント ${situation.pending.from} → ${situation.pending.to} の resume で状態が変わらなかった`);
      }
      continue;
    }
    if (situation.kind === "terminal") {
      return { stop: "complete", condition: "A4", step: situation.state, line: `✅ 完了 — aiw new-task`, exitCode: AUTO_EXIT.humanTurn };
    }
    if (situation.kind === "unknown") {
      return {
        stop: "refused",
        condition: "A25",
        step: situation.state,
        line: `error: current step "${situation.state}" is unknown — aiw status`,
        exitCode: AUTO_EXIT.refused
      };
    }

    // runnable: ここから先は auto の方針（判定器の外・課題E）
    const step = situation.step;
    if (step.executor === "clipboard") {
      return {
        stop: "clipboard",
        condition: "A2",
        step: step.id,
        line: `⏸ 人の番: ${step.id} は clipboard — aiw drive か aiw prompt ${step.id}`,
        exitCode: AUTO_EXIT.humanTurn
      };
    }
    if (step.auto !== true) {
      return {
        stop: "out-of-zone",
        condition: "A3",
        step: step.id,
        line: `⏸ auto の対象外: ${step.id}（executor: ${step.executor}）— aiw drive / aiw exec ${step.id}`,
        exitCode: AUTO_EXIT.humanTurn
      };
    }
    if (ctx.executed.length >= ctx.budget.total) {
      return {
        stop: "budget",
        condition: "A11",
        step: step.id,
        line: `⛔ 予算超過: ${ctx.executed.length}/${ctx.budget.total} — モデル化されていない経路（workflow.yaml と Event Log を確認）`,
        exitCode: AUTO_EXIT.budget
      };
    }

    // exec → run の1サイクル
    const described = describeExecutor(step, config);
    reporter?.stepStarted?.({ index: ctx.executed.length + 1, budget: ctx.budget.total, step, model: described.model, effort: described.effort });
    const startedAt = Date.now();
    const row = (result: string, execResult: ExecutorResult | null, retries: number, reported: string[] = []): AutoExecution => ({
      step: step.id,
      executor: step.executor,
      ...modelsOf(execResult, described.model),
      durationMs: Date.now() - startedAt,
      retries,
      result,
      reported,
      tokens: tokensOf(execResult)
    });

    const exec = await execWithRetry(root, config, step, opts, ctx, retriesUsed);
    retriesUsed += exec.retries;
    if (exec.stop) {
      ctx.executed.push(row(exec.label, exec.result, exec.retries));
      return exec.stop;
    }
    if (signal?.aborted) {
      // exec は終わったが、中断要求が先に来ていた。成果物が完全か分からないので run へ進まない
      ctx.executed.push(row("interrupted", exec.result, exec.retries));
      return interrupted("A20", step.id, "state は変更なし。aiw auto で fresh 再実行");
    }

    // stale status: **exec の後・run の前にだけ**見る（exec の前は遷移元の宣言が残っているのが正常）
    const afterExec = readState(root);
    const stale = staleStatusStep(root, config, afterExec, step.id);
    if (stale) {
      ctx.executed.push(row("stale-status", exec.result, exec.retries));
      return noProgress("A17", step.id, `current-status.json が前ステップ "${stale}" の宣言のまま — executor が status を書かなかった`);
    }

    const before = stateFingerprint(afterExec);
    let outcome: PipelineOutcome;
    try {
      outcome = run(root, config, step.id);
    } catch (error) {
      if (error instanceof EngineError) {
        ctx.executed.push(row("state-changed", exec.result, exec.retries));
        return noProgress("A19", step.id, `state が起動中に変わった（別の aiw が動いている？）: ${error.message}`);
      }
      throw error;
    }
    const reported = outcome.kind === "transitioned" || outcome.kind === "awaiting-approval" ? (outcome.notice?.reported ?? []).map((r) => `${r.type}: ${r.message}`) : [];
    ctx.executed.push(row(outcomeLabel(outcome), exec.result, exec.retries, reported));
    reporter?.outcome?.(outcome, { step: step.id, durationMs: Date.now() - startedAt });

    if (outcome.kind === "halted") {
      return haltStop(outcome);
    }
    if (stateFingerprint(readState(root)) === before) {
      return noProgress("A18", step.id, `${step.id} の反復で状態が変わらなかった（run の結果: ${outcomeLabel(outcome)}）`);
    }
    if (signal?.aborted) {
      // run は同期処理で割り込めないので、完了を待ってから止まる（postActions の途中で止めない）
      return interrupted("A22", readState(root).currentStep, `run の完了を待って停止。aiw auto で続きから`);
    }
  }
}

function noProgress(condition: "A17" | "A18" | "A19", step: string, detail: string): AutoStop {
  return { stop: "no-progress", condition, step, line: `⛔ 無進行: ${detail}`, exitCode: AUTO_EXIT.noProgress };
}

type ExecAttempt = { result: ExecutorResult | null; retries: number; stop: AutoStop | null; label: string };

/** exec と、課題D の再試行。state は読むだけ（exec は state を書かない・不変条件1） */
async function execWithRetry(
  root: string,
  config: WorkflowConfig,
  step: WorkflowStep,
  opts: AutoOptions,
  ctx: LoopContext,
  retriesUsedBefore: number
): Promise<ExecAttempt> {
  const { signal, reporter } = opts;
  const sleep = opts.sleep ?? abortableSleep;
  const limits: Record<RetryCause, number> = {
    "total-timeout": ctx.retry.totalTimeout,
    "idle-timeout": ctx.retry.idleTimeout,
    transient: ctx.retry.transient
  };
  const counts: Record<RetryCause, number> = { "total-timeout": 0, "idle-timeout": 0, transient: 0 };
  let retries = 0;
  const fail = (result: ExecutorResult | null, condition: string, label: string, detail: string): ExecAttempt => ({
    result,
    retries,
    label: `exec-failed(${label})`,
    stop: { stop: "exec-failed", condition, step: step.id, line: `⛔ executor 失敗(${label}) ${step.id}${detail ? `: ${detail}` : ""}`, exitCode: AUTO_EXIT.execFailed }
  });

  for (;;) {
    let result: ExecutorResult;
    try {
      result = await execStep(root, config, step.id, { signal, executor: opts.executor, onProgress: reporter?.progress });
    } catch (error) {
      if (error instanceof PromptAssemblyError) {
        return fail(null, "A15", "assembly", sanitizeMessage(error.message));
      }
      if (error instanceof EngineError) {
        return {
          result: null,
          retries,
          label: "state-changed",
          stop: noProgress("A19", step.id, `state が起動中に変わった（別の aiw が動いている？）: ${error.message}`)
        };
      }
      throw error;
    }
    if (result.ok) {
      return { result, retries, stop: null, label: "ok" };
    }
    if (signal?.aborted) {
      return { result, retries, label: "interrupted", stop: interrupted("A20", step.id, "state は変更なし。aiw auto で fresh 再実行") };
    }

    const cause = classifyExecFailure(result);
    const message = sanitizeMessage(result.error);
    if (cause === "permanent" || cause === "unclassified") {
      return fail(result, "A12", cause, message);
    }
    const condition = cause === "total-timeout" ? "A13a" : cause === "idle-timeout" ? "A13b" : "A14";
    if (counts[cause] >= limits[cause]) {
      return fail(result, condition, `${cause} ×${counts[cause] + 1}`, message);
    }
    if (retriesUsedBefore + retries >= ctx.retry.maxPerRun) {
      return fail(result, condition, `${cause} ・起動あたりの再試行上限 ${ctx.retry.maxPerRun}`, message);
    }

    counts[cause]++;
    retries++;
    const waitMs =
      cause === "total-timeout"
        ? 0
        : cause === "idle-timeout"
          ? ctx.retry.idleWaitMs
          : ctx.retry.transientWaitsMs[Math.min(counts.transient, ctx.retry.transientWaitsMs.length) - 1];
    appendEvent(root, "auto.retry", { runId: ctx.runId, step: step.id, attempt: counts[cause], cause, waitMs, message });
    reporter?.retrying?.({ step: step.id, cause, attempt: counts[cause], max: limits[cause], waitMs, message });
    if (waitMs > 0) {
      await sleep(waitMs, signal);
    }
    if (signal?.aborted) {
      return { result, retries, label: "interrupted", stop: interrupted("A20", step.id, "再試行の待機を打ち切った。state は変更なし") };
    }
  }
}
