// executor レジストリ。workflow.yaml の steps[].executor（ローダーが既定値を注入済み）を
// 実体へ解決する唯一の入口。
import type { ExecutorName } from "../types.js";
import { claudeExecutor } from "./claude.js";
import { clipboardExecutor } from "./clipboard.js";
import { codexExecutor } from "./codex.js";
import type { ExecutorProgress, StepExecutor } from "./types.js";

const REGISTRY: Record<ExecutorName, StepExecutor> = {
  clipboard: clipboardExecutor,
  codex: codexExecutor,
  claude: claudeExecutor
};

/**
 * `aiw drive` が executor 宣言を無視することを人間へ知らせる文言（M3）。
 *
 * drive は人間が1ステップずつ確認する経路なので、M0.4 以来 clipboard 固定で
 * `step.executor` を解決しない。executor が実在しなかった当時は妥当だったが、
 * M3 で codex が実装された結果、**「宣言したのに drive では効かない」**という
 * このコードベースが繰り返し潰してきた「宣言はあるが効いていない」型になった。
 *
 * drive を executor 対応にするのは M3 の実タスク検証が済んでから（そのほうが
 * executor の挙動と drive の挙動変更を切り分けられる）。それまでの間、
 * **黙って無視せず、宣言が効いていないことを毎回言う。**
 *
 * @returns 宣言が無視される場合の警告文。clipboard（既定）なら null
 */
export function driveExecutorNotice(stepId: string, executor: ExecutorName | undefined): string | null {
  if (!executor || executor === "clipboard") {
    return null;
  }
  return (
    `⚠ "${stepId}" は executor: ${executor} を宣言していますが、drive は clipboard 固定です（この宣言は効きません）。` +
    `executor で実行するなら drive を抜けて \`aiw exec ${stepId}\` を使ってください。`
  );
}

/**
 * 進行イベントを**画面へ**出すか（M3・課題I）。
 *
 * 既定は **codex 自身の発言（message）だけ**。shell / edit / thinking は画面へ出さない。
 * 実測: 大きめのタスク 1 本で 119 イベント・shell 36 回。全種類を流すと**画面がコマンドで
 * 埋まり、モデルが何を言っているかが読めなくなる**。
 *
 * ⚠️ **`error` は既定でも必ず出す。** 失敗を黙って通さないのはこのコードベースの一貫した規律で、
 * 「発言だけ」を字義どおり適用して例外を握り潰すのは筋が違う。
 *
 * 捨てているのは**表示だけ**。全イベントは `runs/codex/` の JSONL に残り、`--verbose` でも見られる。
 */
export function visibleOnScreen(kind: ExecutorProgress["kind"], verbose: boolean): boolean {
  return verbose || kind === "message" || kind === "error";
}

export function getExecutor(name: ExecutorName): StepExecutor {
  const executor = REGISTRY[name];
  if (!executor) {
    // ローダーが未知の値を弾くため通常は到達しない（プログラムからの直接呼び出し用の保険）。
    throw new Error(`Unknown executor "${name}".`);
  }
  return executor;
}

export { copyStepPromptToClipboard, createClipboardExecutor, clipboardExecutor, clipboardMeta } from "./clipboard.js";
export type { ClipboardDeps, ClipboardMeta, ClipboardMode } from "./clipboard.js";
export type { ExecutorRequest, ExecutorResult, StepExecutor } from "./types.js";
