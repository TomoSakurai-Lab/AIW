import type { WorkflowContext } from "./files.js";
import { loadPromptOrDefault, HEARTBEAT_DEFAULT_PROMPT } from "./prompt.js";
import { updateState } from "./state.js";

export async function runHeartbeat(ctx: WorkflowContext): Promise<string> {
  const prompt = await loadPromptOrDefault(ctx, "prompts/heartbeat.md", HEARTBEAT_DEFAULT_PROMPT);
  await updateState(ctx, {
    lastClaudeMessageAt: new Date().toISOString()
  });
  return prompt;
}
