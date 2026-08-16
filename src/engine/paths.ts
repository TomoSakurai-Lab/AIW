import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the engine's bundled assets dir (tools/aiw/assets), used by `aiw init` to scaffold a root.
const here = path.dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = path.resolve(here, "..", "..", "assets");

export const CONFIG_MARKER = path.join("config", "workflow.yaml");

export type RootPaths = {
  root: string;
  configDir: string;
  workflowYaml: string;
  schemasDir: string;
  promptsDir: string;
  skillsDir: string;
  instructionsDir: string;
  templatesDir: string;
  attemptsDir: string;
  archiveDir: string;
  runsDir: string;
  researchDir: string;
  stateFile: string;
  eventLog: string;
};

export function rootPaths(root: string): RootPaths {
  const abs = path.resolve(root);
  return {
    root: abs,
    configDir: path.join(abs, "config"),
    workflowYaml: path.join(abs, "config", "workflow.yaml"),
    schemasDir: path.join(abs, "schemas"),
    promptsDir: path.join(abs, "prompts"),
    skillsDir: path.join(abs, "skills"),
    instructionsDir: path.join(abs, "instructions"),
    templatesDir: path.join(abs, "templates"),
    attemptsDir: path.join(abs, "attempts"),
    archiveDir: path.join(abs, "archive"),
    runsDir: path.join(abs, "runs"),
    researchDir: path.join(abs, "research"),
    stateFile: path.join(abs, "state.json"),
    eventLog: path.join(abs, "runs", "execution-log.jsonl")
  };
}

// Resolve the workflow root: explicit override → AIW_ROOT → upward search for config/workflow.yaml
// → default ".ai-workflow2" under cwd.
export function resolveRoot(explicit?: string, startDir = process.cwd()): string {
  if (explicit) {
    return path.resolve(explicit);
  }
  if (process.env.AIW_ROOT) {
    return path.resolve(process.env.AIW_ROOT);
  }

  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, ".ai-workflow2");
    if (existsSync(path.join(candidate, CONFIG_MARKER))) {
      return candidate;
    }
    // also allow the marker directly at current (root passed as cwd)
    if (existsSync(path.join(current, CONFIG_MARKER))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return path.resolve(startDir, ".ai-workflow2");
}

// Resolve a path referenced from workflow.yaml (e.g. `schema: schemas/current-status.schema.json`)
// relative to the root, so §12's relative paths hold at runtime.
export function resolveConfigRef(root: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.join(path.resolve(root), ref);
}
