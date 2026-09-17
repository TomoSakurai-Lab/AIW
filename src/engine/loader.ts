import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { rootPaths } from "./paths.js";
import {
  DEFAULT_EXECUTOR,
  EFFORT_LEVELS,
  EXECUTOR_NAMES,
  type EffortLevel,
  type ExecutorName,
  type WorkflowConfig,
  type WorkflowStep
} from "./types.js";

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

// steps[].effort（M4）。未指定は「渡さない」。未知の値は executor 名と同じくロード時に落とす
// — 実行して CLI に怒られるより、config を読んだ瞬間に分かるほうがいい。
function resolveEffort(id: string, value: unknown): EffortLevel | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`Step "${id}" declares an unknown effort "${String(value)}". Allowed: ${EFFORT_LEVELS.join(", ")}.`);
  }
  return value as EffortLevel;
}

/**
 * 改名した設定キー（2026-09-17・M4.4 の判定で昇格した唯一の共通化）。
 *
 * エンジンは claude のステップでも `codexTimeoutMs` / `codexIdleTimeoutMs` を読んでいた——
 * キーは実質共通なのに名前だけが codex 用だったので、中立名へ揃えた。
 *
 * ⚠️ **旧キーは即削除しない。** 消すと既存 runtime の設定が**黙って既定値に落ちる**
 * （「黙って」が一番悪い形）。1 世代の間は読み替え、読んだら deprecation を残す。
 * ⚠️ **読み替えはここ 1 箇所だけ。** エンジン / executor は新キーしか読まない
 * （旧キーのフォールバックを各所に書くと、同じ規則を複数箇所に持つことになる）。
 */
export const RENAMED_SETTINGS: ReadonlyArray<{ from: string; to: string }> = [
  { from: "codexTimeoutMs", to: "executorTimeoutMs" },
  { from: "codexIdleTimeoutMs", to: "executorIdleTimeoutMs" }
];

/** 削除した設定キー。書かれていても効果が無いことを知らせる（黙って無視しない）。 */
export const REMOVED_SETTINGS: ReadonlyArray<{ key: string; note: string }> = [
  {
    key: "claudeTimeoutMs",
    note: "2026-09-17 に削除した（エンジン経由では一度も参照されていなかった）。総上限は steps.<id>.timeoutMs か settings.executorTimeoutMs に書く"
  }
];

/** 旧キーを新キーへ読み替え、deprecation を集める。入力は変更しない。 */
export function migrateSettings(raw: Record<string, unknown>): {
  settings: Record<string, unknown>;
  deprecations: string[];
} {
  const settings = { ...raw };
  const deprecations: string[] = [];
  for (const { from, to } of RENAMED_SETTINGS) {
    if (!(from in settings)) {
      continue;
    }
    if (to in settings) {
      deprecations.push(`settings.${from} は旧名で、settings.${to} が優先されたため無視した。旧キーを削除してください`);
    } else {
      settings[to] = settings[from];
      deprecations.push(`settings.${from} は旧名。settings.${to} として読み替えた（読み替えは 1 世代の間だけ）。改名してください`);
    }
    delete settings[from];
  }
  for (const { key, note } of REMOVED_SETTINGS) {
    if (key in settings) {
      deprecations.push(`settings.${key} は効果が無い: ${note}`);
      delete settings[key];
    }
  }
  return { settings, deprecations };
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
    const effort = resolveEffort(id, step.effort);
    steps[id] = {
      id,
      ...step,
      executor: resolveExecutor(id, step.executor),
      // 未指定は「キーごと落とす」。undefined を残すと `?? settings` の解決に影響しないが、
      // JSON 化した config の差分に空欄が並ぶので、宣言が無いことをそのまま形で表す。
      ...(effort ? { effort } : {})
    } as WorkflowStep;
  }

  const { settings, deprecations } = migrateSettings(parsed.settings ?? {});
  return {
    version: parsed.version,
    settings: settings as WorkflowConfig["settings"],
    ...(deprecations.length > 0 ? { deprecations } : {}),
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
