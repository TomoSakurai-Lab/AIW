import clipboard from "clipboardy";
import type { WorkflowContext } from "./files.js";
import { readWorkflowFileIfExists } from "./files.js";

export async function loadPromptOrDefault(
  ctx: WorkflowContext,
  relativePath: string,
  fallback: string
): Promise<string> {
  const prompt = await readWorkflowFileIfExists(ctx, relativePath);
  return prompt?.trimEnd() ?? fallback.trimEnd();
}

export async function loadTemplateOrDefault(
  ctx: WorkflowContext,
  templateName: string,
  fallback: string
): Promise<string> {
  return loadPromptOrDefault(ctx, `prompt-templates/${templateName}`, fallback);
}

export async function outputPrompt(prompt: string): Promise<void> {
  const normalized = `${prompt.trimEnd()}\n`;
  process.stdout.write(normalized);

  try {
    await clipboard.write(normalized);
    console.error("copied: prompt copied to clipboard.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`warning: clipboard copy failed; use the stdout prompt. (${message})`);
  }
}

export const HEARTBEAT_DEFAULT_PROMPT = `Heartbeat:
現在Codex実装待ちです。
新しい判断は不要です。
直前のコンテキストを維持してください。
次の入力は current-result.md または git diff になります。`;

export const RESEARCH_DEFAULT_PROMPT = `# Current Phase

Research

.ai-workflow/current-task.md を読み、必要な調査・要件整理・実装方針整理を行ってください。
最終的に .ai-workflow/context-package.md と .ai-workflow/codex-prompt.md を生成または更新してください。`;

export const CODEX_PROMPT = `# Current Phase

Implementation

以下のファイルを読んで実装してください。

- .ai-workflow/codex-system.md
- .ai-workflow/context-package.md
- .ai-workflow/codex-prompt.md

実装完了後は .ai-workflow/current-result.md を作成または更新してください。`;

export const REVIEW_PROMPT = `# Current Phase

Review

あなたはシニアレビュー担当です。

以下を確認してください。

- .ai-workflow/context.md
- .ai-workflow/current-task.md
- .ai-workflow/context-package.md
- .ai-workflow/codex-prompt.md
- .ai-workflow/current-result.md
- Git差分

レビュー結果は .ai-workflow/current-review.md に保存してください。`;

export const FIX_PROMPT = `# Current Phase

Fix

以下を読んでください。

- .ai-workflow/codex-system.md
- .ai-workflow/context-package.md
- .ai-workflow/current-review.md

current-review.md の Fix Scope のみ参照して修正してください。
Critical / Major のみ対応してください。Minor / Good / Backlog は対応しないでください。`;

export const IMPROVE_CHECK_PROMPT = `# Current Phase

Improve Check

レビュー内容が反映されているか確認してください。

- .ai-workflow/current-review.md
- .ai-workflow/current-result.md
- Git差分

Critical のみ確認してください。`;

export const REFLECT_PROMPT = `# Current Phase

Reflection

あなたはAI開発ワークフローのReflection Agentです。

- .ai-workflow/context.md
- .ai-workflow/current-task.md
- .ai-workflow/context-package.md
- .ai-workflow/current-result.md
- .ai-workflow/current-review.md
- .ai-workflow/learnings.md
- .ai-workflow/research/

今回のタスク・レビュー・実装結果を分析し、再利用可能な知識だけを抽出してください。`;
