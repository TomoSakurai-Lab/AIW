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

/**
 * 進行の1行サマリ（M3・課題I）。
 *
 * clipboard 運用では人間が対話画面で進行を見ていた。executor 化でその可視性を失わないため、
 * executor は**イベントを流すだけ**にし、整形と表示は CLI が担う
 * （「エンジンは結果を返す、CLI が表示する」の既存分離）。
 *
 * ⚠️ 全文は載せない。種別と対象の要約のみ。全文は runs/ の JSONL にある。
 * ⚠️ 生 session ID を含めない（防衛線2の grep テスト対象）。
 */
export type ExecutorProgress = {
  kind: "thinking" | "edit" | "shell" | "message" | "tokens" | "error";
  /** 1行の要約。表示側がそのまま出せる長さに収めること */
  text: string;
};

export type ExecutorRequest = {
  /** ランタイムルート（.ai-workflow2 のパス）。成果物はこの配下に置く */
  root: string;
  /** workflow 定義（読み取り専用として扱う） */
  config: WorkflowConfig;
  /** 対象ステップ。id / executor はローダーが注入済み */
  step: WorkflowStep;
  // --- 以下は optional（M3 で追加）。既存 executor は無視してよい ---
  /** 中断シグナル。無人運転で外から止めるための口 */
  signal?: AbortSignal;
  /** 実行の作業ディレクトリ（codex の -C）。未指定なら executor が解決する */
  projectRoot?: string;
  /** タイムアウト（ミリ秒）。未指定なら executor の既定 */
  timeoutMs?: number;
  /** 進行の逐次通知。**バッファせず、届いた順にそのまま呼ぶこと** */
  onProgress?: (event: ExecutorProgress) => void;
};

export type ExecutorResult = {
  /** 成果物の生成（または人手への受け渡し）に成功したか */
  ok: boolean;
  /** executor 自身が書いたファイル（root 相対）。人手に委ねた場合は空 */
  outputs: string[];
  /** ok:false のときの人間向けメッセージ */
  error?: string;
  /**
   * 失敗の種類（M3）。M5 の consecutiveExecFailures が
   * 「再試行すべきか即停止か」を判断するために使う。
   *
   * ⚠️ **分類の入力に exit code を使わない。** 実測で、read-only サンドボックスが
   * 書き込みを拒否しても exit 0 で返ることを確認している。exit code が語るのは
   * 「プロセスが完走したか」だけ。分類は JSONL の error イベントと成果物の有無から導く。
   */
  failureKind?: "transient" | "permanent";
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
