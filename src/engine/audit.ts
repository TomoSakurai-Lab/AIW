// review-audit の起動提案（M4 段階1-2・設計 課題G）。
//
// `auditPolicy.alsoSuggestOn: [model-change]` は宣言だけがあって**誰も参照していなかった**
// （KI-05: 型はあるがエンジンが読まない）。review を executor 化する変更は
// **それ自体がモデル変更**なのに発火しない——宣言だけの機構をそのままにしない。
//
// ## 責務の境界
//
// **提案するだけ。起動しない。判定・遷移・exit code を変えない**（不変条件1）。
// `aiw run` の完了後に CLI から呼ぶ。`runStep` 自体には手を入れていない
// （counterOwner: cli という既存の分担のとおり）。
//
// ## なぜ Event Log を材料にするのか
//
// 「前回どのモデルで review したか」は state.json に無い。Event Log の `exec.completed` が
// executor と modelRequested を持っているので、そこから 2 件取って比べる。
// ⚠️ 記録が 1 件しか無い（＝初回）ときは**提案しない**。「変わった」と言えるのは
// 比較対象があるときだけで、無いことを「変わった」へ倒すと毎回鳴る狼になる。
import { appendEvent } from "./eventLog.js";
import { readEventLog } from "./observed.js";
import type { WorkflowConfig } from "./types.js";

/** 実行の同一性を判断する材料。**指定値**であって実測値ではない（modelObserved は使わない）。 */
export type RunIdentity = {
  executor: string;
  /** settings/step の指定値。未指定は "unspecified"（三値の規律） */
  model: string;
};

export type AuditSuggestion = {
  step: string;
  trigger: "model-change";
  previous: RunIdentity;
  current: RunIdentity;
  /** 人間向けの1行 */
  message: string;
};

function identityOf(record: Record<string, unknown>): RunIdentity | null {
  const meta = (record.meta ?? {}) as Record<string, unknown>;
  const executor = typeof record.executor === "string" ? record.executor : null;
  if (!executor) {
    return null;
  }
  return { executor, model: typeof meta.modelRequested === "string" ? meta.modelRequested : "unspecified" };
}

function sameRun(a: RunIdentity, b: RunIdentity): boolean {
  return a.executor === b.executor && a.model === b.model;
}

/**
 * そのステップの直近 2 実行を比べ、executor / モデルが変わっていれば提案を返す。
 *
 * **宣言が無ければ何もしない**（`auditPolicy.alsoSuggestOn` に `model-change` が無い場合）。
 * 提案するときは `audit.suggested` を Event Log へ残す——画面に出ただけで消えると、
 * 「提案したのに誰も監査しなかった」が後から辿れない。
 */
export function suggestAuditOnModelChange(
  root: string,
  config: WorkflowConfig,
  stepId: string
): AuditSuggestion | null {
  const triggers = (config.auditPolicy?.alsoSuggestOn ?? []) as unknown[];
  if (!Array.isArray(triggers) || !triggers.includes("model-change")) {
    return null;
  }
  const records = readEventLog(root);
  if (records === "missing" || records === "unreadable") {
    return null;
  }
  const runs = records
    .filter((r) => r.event === "exec.completed" && r.step === stepId)
    .map(identityOf)
    .filter((x): x is RunIdentity => x !== null);
  if (runs.length < 2) {
    return null; // 初回は比較対象が無い。「不明」を「変わった」へ倒さない
  }
  const current = runs[runs.length - 1];
  const previous = runs[runs.length - 2];
  if (sameRun(previous, current)) {
    return null;
  }
  const describe = (r: RunIdentity) => `${r.executor} / ${r.model}`;
  const suggestion: AuditSuggestion = {
    step: stepId,
    trigger: "model-change",
    previous,
    current,
    message:
      `model-change: "${stepId}" の実行系が変わりました（${describe(previous)} → ${describe(current)}）。` +
      `review-audit の実行を提案します（検出力が変わっていないかの確認）。`
  };
  appendEvent(root, "audit.suggested", {
    step: stepId,
    trigger: suggestion.trigger,
    previous,
    current,
    message: suggestion.message
  });
  return suggestion;
}
