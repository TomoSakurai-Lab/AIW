import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";

export const WORKFLOW_DIR = ".ai-workflow";

export const REQUIRED_STATUS_FILES = [
  "current-task.md",
  "context-package.md",
  "codex-prompt.md",
  "current-result.md",
  "current-review.md"
] as const;

export type WorkflowContext = {
  rootDir: string;
  workflowDir: string;
};

export function findProjectRoot(startDir = process.cwd()): string | null {
  let current = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(current, WORKFLOW_DIR))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function getWorkflowContext(): WorkflowContext {
  const rootDir = findProjectRoot();
  if (!rootDir) {
    throw new Error(
      ".ai-workflow/ was not found. Run aiw from the project root or one of its child directories."
    );
  }

  return {
    rootDir,
    workflowDir: path.join(rootDir, WORKFLOW_DIR)
  };
}

export function workflowPath(ctx: WorkflowContext, relativePath: string): string {
  return path.join(ctx.workflowDir, relativePath);
}

export function workflowFileExists(ctx: WorkflowContext, relativePath: string): boolean {
  return existsSync(workflowPath(ctx, relativePath));
}

export async function readWorkflowFileIfExists(
  ctx: WorkflowContext,
  relativePath: string
): Promise<string | null> {
  const filePath = workflowPath(ctx, relativePath);
  if (!existsSync(filePath)) {
    return null;
  }

  return readFile(filePath, "utf8");
}

export function warnMissingWorkflowFile(ctx: WorkflowContext, relativePath: string): void {
  if (!workflowFileExists(ctx, relativePath)) {
    console.warn(`warning: .ai-workflow/${relativePath} was not found.`);
  }
}
