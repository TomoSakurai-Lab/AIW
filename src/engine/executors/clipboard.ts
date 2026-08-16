// clipboard executor — 現行の手貼り運用（既定 / フォールバック）。
//
// ステップの phase prompt（prompts/<step>.md）をクリップボードへ載せ、成果物の作成は
// 人間 + 対話AIに委ねる。executor 自身はファイルを書かないため outputs は常に空。
// state.json には一切触らない（executors/types.ts の契約）。
import { existsSync } from "node:fs";
import path from "node:path";
import clipboardy from "clipboardy";
import { rootPaths } from "../paths.js";
import { assembleStepPrompt } from "../promptAssembly.js";
import type { ExecutorName, WorkflowStep } from "../types.js";
import type { ExecutorRequest, ExecutorResult, StepExecutor } from "./types.js";

export type ClipboardMode =
  | "quiet" // `aiw drive` / `aiw exec`: 標準出力へは何も出さない。プロンプトは生のまま転送
  | "print"; // `aiw prompt`: 正規化した本文を stdout に出し、結果を stderr へ通知

export type ClipboardDeps = {
  mode?: ClipboardMode;
  write?: (text: string) => Promise<void>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

export type ClipboardMeta = {
  executor: "clipboard";
  /** 使用した prompts/<step>.md の絶対パス。専用プロンプトが無い場合は null */
  promptFile: string | null;
  outcome: "copied" | "copy-failed" | "no-prompt";
  message?: string;
};

// 呼び出し元がクリップボードの結果で分岐できるよう、meta を型付きで取り出す。
export function clipboardMeta(result: ExecutorResult): ClipboardMeta | null {
  const meta = result.meta;
  return meta && meta.executor === "clipboard" ? (meta as ClipboardMeta) : null;
}

// クリップボード出力の実体。executor と `aiw prompt` の共通経路。
//
// `step` を受け取るのは M2 の組み立てのため。**渡さないと Skill / Instructions が結合されない**
// ので、workflow.yaml に step があるなら必ず渡すこと。M0.4 では `aiw prompt` を
// 「config を読まない」設計にしていたが、Skill 宣言は config にしか無く、
// 読まなければ手順が欠けたプロンプトを黙って出すことになるため M2 で撤回した。
export async function copyStepPromptToClipboard(
  root: string,
  stepId: string,
  deps: ClipboardDeps = {},
  step?: WorkflowStep
): Promise<ClipboardMeta> {
  const mode: ClipboardMode = deps.mode ?? "quiet";
  const write = deps.write ?? ((text: string) => clipboardy.write(text));
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => console.error(text));

  // M2: Skill / Instructions が宣言されていれば結合する。宣言があってファイルが無ければ
  // assembleStepPrompt が投げる（静かに Skill 抜きで組み立てない）。
  const assembly = assembleStepPrompt(root, stepId, step);

  // 専用プロンプトも Skill も無いのは失敗ではない（codex 系は codex-prompt.md /
  // current-review.md をそのまま渡す運用）。どう見せるかは呼び出し元に委ねる。
  if (assembly.parts.length === 0) {
    return { executor: "clipboard", promptFile: null, outcome: "no-prompt" };
  }
  const promptFile = path.join(rootPaths(root).promptsDir, `${stepId}.md`);
  const raw = `${assembly.text}\n`;
  // print は本文を stdout に出すため末尾を正規化し、同じ文字列をクリップボードへ載せる。
  // quiet は現行の drive と同じく生の本文をそのまま転送する（この差分は意図的に温存）。
  const payload = mode === "print" ? `${raw.trimEnd()}\n` : raw;

  if (mode === "print") {
    stdout(payload);
  }

  try {
    await write(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode === "print") {
      stderr(`warning: clipboard copy failed; use the stdout prompt. (${message})`);
    }
    // クリップボードは best-effort。プロンプト本文はディスク上に在るので失敗扱いにしない。
    return { executor: "clipboard", promptFile, outcome: "copy-failed", message };
  }

  if (mode === "print") {
    stderr("copied: prompt copied to clipboard.");
  }
  return { executor: "clipboard", promptFile, outcome: "copied" };
}

export function createClipboardExecutor(deps: ClipboardDeps = {}): StepExecutor {
  return {
    name: "clipboard" as ExecutorName,
    async execute(req: ExecutorRequest): Promise<ExecutorResult> {
      const meta = await copyStepPromptToClipboard(req.root, req.step.id, deps, req.step);
      // 人手に委ねる方式なので executor 自身は何も書かない。プロンプトの有無に関わらず ok。
      return { ok: true, outputs: [], meta };
    }
  };
}

/** レジストリ既定のインスタンス（quiet）。 */
export const clipboardExecutor = createClipboardExecutor();
