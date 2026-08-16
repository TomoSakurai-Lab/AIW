// StepExecutor — ステップの成果物を作る側の共通インターフェース(M0.4)。
//
// 契約(設計原則1「実行と検証を分離する」):
//
//   aiw exec <step>   executor を呼び、成果物を作る。state.json は変更しない
//   aiw run  <step>   検証 → 承認 → 遷移確定 → postActions → state更新 → Event Log
//
// executor は次のことを **してはならない**:
//   - state.json の読み書き（currentStep / status / fixAttempts 等の一切）
//   - validator の実行、遷移の判定、postActions の起動
//   - 会話履歴やセッションを前提にした処理（各ステップは入力成果物ファイルだけから
//     再実行できること。resume は最適化であり正しさの要件にしない）
//
// この制約は型でも表現している: ExecutorRequest は EngineState を運ばず、
// ExecutorResult も state の変更を表現できない。executor が state を触りたくなったら、
// それは責務の置き場所を間違えているサイン。
import type { ExecutorName, WorkflowConfig, WorkflowStep } from "../types.js";

export type ExecutorRequest = {
  /** ランタイムルート（.ai-workflow2 のパス）。成果物はこの配下に置く */
  root: string;
  /** workflow 定義（読み取り専用として扱う） */
  config: WorkflowConfig;
  /** 対象ステップ。id / executor はローダーが注入済み */
  step: WorkflowStep;
};

export type ExecutorResult = {
  /** 成果物の生成（または人手への受け渡し）に成功したか */
  ok: boolean;
  /** executor 自身が書いたファイル（root 相対）。人手に委ねた場合は空 */
  outputs: string[];
  /** ok:false のときの人間向けメッセージ */
  error?: string;
  /** 実行メタ情報。Event Log にそのまま載せる想定（生の session ID は入れない） */
  meta?: Record<string, unknown>;
};

export interface StepExecutor {
  readonly name: ExecutorName;
  execute(req: ExecutorRequest): Promise<ExecutorResult>;
}

/** 未実装 executor（M2 / M3 で実装）が返す定型の結果。 */
export function notImplemented(name: ExecutorName, milestone: string): ExecutorResult {
  return {
    ok: false,
    outputs: [],
    error: `executor "${name}" は未実装です（${milestone} で実装予定）。workflow.yaml の executor を "clipboard" に戻すか、手動で成果物を作成してください。`,
    meta: { executor: name, implemented: false }
  };
}
