// Core engine types. WorkflowStep mirrors design rev.5 §7.1 verbatim; EngineState mirrors §6.11.

export type FileRef = {
  path: string;
  optional?: boolean;
};

export type ValidatorType =
  | "file-exists"
  | "json-schema"
  | "artifact-contract"
  | "diff-scope"
  | "token-range"
  | "verify-local"
  | "command-exit-code"
  | "consumer-presence"
  | "measurement-completeness";

export type ValidatorRef = {
  type: ValidatorType;
  onViolation: "report" | "halt";
  // type-specific fields
  targets?: string[]; // file-exists
  target?: string; // json-schema / artifact-contract / token-range
  schema?: string; // json-schema
  artifact?: string; // artifact-contract: artifacts 定義のキー
  declaredFilesFrom?: string; // diff-scope
  command?: string; // verify-local: settings.verifyLocal のキー
  min?: number; // token-range
  max?: number;
  manifest?: string;
  result?: string;
  consumerRoot?: string;
  apiPattern?: string;
  minConsumers?: number;
};

export type RetryPolicy = {
  counter: string; // state.json 側のカウンタ名
  maxRetries: number;
  retryOn: string[]; // リトライとみなす差し戻し元 result(§7.6: カウント条件ではない)
  onExhausted: "escalate";
};

export type ApprovalPolicy = {
  required: true;
  actor: "human";
  timing: "before" | "after";
  autoApprove?: boolean;
  timeoutHours?: number;
  onTimeout?: "pause";
  onReject: "rerun" | "halt";
};

export type Transition = {
  next: string;
};

// 成果物の作り手(§M0.4)。role が「誰の仕事か」なのに対し、executor は「どう起動するか」。
export const EXECUTOR_NAMES = ["clipboard", "codex", "claude"] as const;
export type ExecutorName = (typeof EXECUTOR_NAMES)[number];
export const DEFAULT_EXECUTOR: ExecutorName = "clipboard";

export type WorkflowStep = {
  id: string; // ローダーが steps マップキーから注入(§7.1)
  // `cli` は testing ステップ専用だったが、testing ごと削除した（2026-08-07）。
  // テストの検証は verify-local validator が担う。再導入するなら role を足すだけでなく、
  // 「実行手段のない role」を弾く分岐も一緒に戻すこと（無いと runStep が role を無視して
  // 完了処理へ進み、袋小路になる）。経緯は docs/aiw-known-issues.md KI-09。
  role: "claude" | "codex" | "human";
  executor: ExecutorName; // YAML では省略可。ローダーが未指定時 DEFAULT_EXECUTOR を注入
  session?: "feature" | "fresh";
  command?: string;
  inputs: FileRef[];
  outputs: FileRef[];
  optionalOutputs?: FileRef[];
  /** M2: skills/<name>/SKILL.md。宣言があってファイルが無ければエラー（静かに省略しない） */
  skill?: string;
  /** M2: instructions/<name>.md。必須。宣言があってファイルが無ければエラー */
  instructions?: string[];
  /** M2: 環境固有の instructions/<name>.md。不在は正常だが、省略は出力に明記する */
  optionalInstructions?: string[];
  validators?: ValidatorRef[];
  retryPolicy?: RetryPolicy;
  postActions?: string[];
  approval?: ApprovalPolicy;
  transitions: Record<string, Transition>;
  standalone?: boolean;
};

export type ArtifactContract =
  | {
      type: "markdown-sections";
      sections: string[];
    }
  | {
      type: "json-schema";
      schema: string;
    };

export type ArtifactDef = {
  path: string;
  contract: ArtifactContract;
};

export type WorkflowConfig = {
  version: number;
  settings: {
    statusFile: string;
    singleActiveFeature?: boolean;
    /** diff-scope の検査対象リポジトリ。絶対パス、または runtimeRoot からの相対。
     *  未指定なら runtimeRoot の親から `git rev-parse --show-toplevel` で自動解決する。
     *  runtimeRoot(.ai-workflow2 の場所)とは別概念なので混同しないこと。 */
    repoRoot?: string;
    diffScope?: { exclude?: string[] };
    /** verify-local のコマンド定義。キーは validator の `command` が参照する */
    verifyLocal?: Record<
      string,
      {
        cwd?: string;
        command: string[];
        countFilesExcluding?: string[];
        timeoutMs?: number;
        notChecked?: string;
      }
    >;
    knownFailurePatternsFile?: string;
    testCommand?: string;
    [key: string]: unknown;
  };
  defaults?: Record<string, unknown>;
  versions?: Record<string, unknown>;
  artifacts: Record<string, ArtifactDef>;
  steps: Record<string, WorkflowStep>;
  auditPolicy?: Record<string, unknown>;
};

// current-status.json — the AI/CLI declaration that drives branching (§6.1)
export type Status = {
  step: string;
  result: string;
  reason: string;
  nextPhaseId?: string | null;
};

export type HaltedReason =
  | "escalation"
  | "invalid-status"
  | "validation-failed"
  | "approval-rejected"
  | "post-action-failed";

// Progress marker used to make Reflection-style postAction chains resumable & idempotent.
export type PendingTransition = {
  from: string; // step that produced the status
  to: string; // committed destination once postActions succeed
  result: string;
  isRetry: boolean;
  completedPostActions: string[]; // postActions already done (idempotency/resume)
  nextPhaseId?: string | null;
};

// state.json (§6.11) + resume bookkeeping.
export type EngineState = {
  featureId: string | null;
  taskId: string | null;
  mode: "single" | "multi" | string;
  currentStep: string;
  phase: string | null;
  status: "ready" | "halted" | "awaiting-approval" | "running" | string;
  fixAttempts: number;
  cleanReviewStreak: number;
  haltedReason: HaltedReason | null;
  pendingApproval: string | null;
  lastCompletedStep: string | null;
  updatedAt: string | null;
  // resume bookkeeping (non-§6.11, engine-internal)
  pendingTransition: PendingTransition | null;
};

export const DEFAULT_ENGINE_STATE: EngineState = {
  featureId: null,
  taskId: null,
  mode: "single",
  currentStep: "task-planning",
  phase: null,
  status: "ready",
  fixAttempts: 0,
  cleanReviewStreak: 0,
  haltedReason: null,
  pendingApproval: null,
  lastCompletedStep: null,
  updatedAt: null,
  pendingTransition: null
};
