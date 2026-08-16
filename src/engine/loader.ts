import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { rootPaths } from "./paths.js";
import { DEFAULT_EXECUTOR, EXECUTOR_NAMES, type ExecutorName, type WorkflowConfig, type WorkflowStep } from "./types.js";

// steps[].executor を検証して返す。未指定は現行動作（clipboard）。
// 未知の値はロード時に落とす — 実行時に初めて気付くより、config を読んだ瞬間に分かるほうがいい。
function resolveExecutor(id: string, value: unknown): ExecutorName {
  if (value === undefined || value === null) {
    return DEFAULT_EXECUTOR;
  }
  if (typeof value !== "string" || !(EXECUTOR_NAMES as readonly string[]).includes(value)) {
    throw new Error(
      `Step "${id}" declares an unknown executor "${String(value)}". Allowed: ${EXECUTOR_NAMES.join(", ")}.`
    );
  }
  return value as ExecutorName;
}

// Loads workflow.yaml and injects `id` into each step from its map key (§7.1).
export function loadWorkflow(root: string): WorkflowConfig {
  const { workflowYaml } = rootPaths(root);
  let raw: string;
  try {
    raw = readFileSync(workflowYaml, "utf8");
  } catch {
    throw new Error(
      `workflow.yaml not found at ${workflowYaml}. Run "aiw init ${root}" first.`
    );
  }

  let parsed: any;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`workflow.yaml is not valid YAML: ${message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("workflow.yaml did not parse to an object.");
  }
  if (!parsed.steps || typeof parsed.steps !== "object") {
    throw new Error("workflow.yaml is missing a `steps` map.");
  }

  const steps: Record<string, WorkflowStep> = {};
  for (const [id, step] of Object.entries<any>(parsed.steps)) {
    if (!step || typeof step !== "object") {
      throw new Error(`Step "${id}" is not an object.`);
    }
    if (step.id !== undefined && step.id !== id) {
      throw new Error(
        `Step "${id}" declares a conflicting id "${step.id}" in its body. Remove it; id is injected from the map key.`
      );
    }
    steps[id] = { id, ...step, executor: resolveExecutor(id, step.executor) } as WorkflowStep;
  }

  return {
    version: parsed.version,
    settings: parsed.settings ?? {},
    defaults: parsed.defaults,
    versions: parsed.versions,
    artifacts: parsed.artifacts ?? {},
    steps,
    auditPolicy: parsed.auditPolicy
  };
}

export function getStep(config: WorkflowConfig, id: string): WorkflowStep {
  const step = config.steps[id];
  if (!step) {
    throw new Error(`Unknown step "${id}".`);
  }
  return step;
}
