import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { rootPaths } from "./paths.js";
import type { WorkflowConfig } from "./types.js";

export function sha256File(file: string): string | null {
  if (!existsSync(file)) {
    return null;
  }
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  return `sha256:${hash}`;
}

// step id -> versions.prompts key.
// implementation / fix were missing until M1: their prompts existed and changed, but every
// Event Log entry recorded promptVersion/promptHash as null, so those changes could not be
// correlated with measurements. Any step that has prompts/<step>.md belongs here.
const PROMPT_KEY: Record<string, string> = {
  "task-planning": "taskPlanning",
  research: "research",
  implementation: "implementation",
  review: "review",
  fix: "fix",
  "review-audit": "reviewAudit",
  "improve-check": "improveCheck",
  reflection: "reflection"
};

// step id -> [versions.templates key, template filename]
const TEMPLATE_KEY: Record<string, [string, string]> = {
  "task-planning": ["currentTask", "current-task.md"],
  research: ["researchFindings", "research-findings.md"],
  implementation: ["currentResult", "current-result.md"],
  fix: ["currentResult", "current-result.md"],
  review: ["currentReview", "current-review.md"]
};

export type SkillVersionInfo = {
  skill: string | null;
  skillVersion: number | null;
  skillHash: string | null;
  /** 結合に参加した instructions（環境固有で省略されたものは含まない） */
  instructions: Array<{ name: string; version: number | null; hash: string | null }>;
};

export type VersionInfo = {
  workflowVersion: number | null;
  promptVersion: number | null;
  promptHash: string | null;
  templateVersion: number | null;
  templateHash: string | null;
  schemaVersion: number | null;
  schemaHash: string | null;
} & SkillVersionInfo;

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function versionInfo(root: string, config: WorkflowConfig, stepId: string): VersionInfo {
  const paths = rootPaths(root);
  const versions = (config.versions ?? {}) as any;

  const promptKey = PROMPT_KEY[stepId];
  const promptFile = promptKey ? path.join(paths.promptsDir, `${stepId}.md`) : null;

  const tmpl = TEMPLATE_KEY[stepId];
  const templateFile = tmpl ? path.join(paths.templatesDir, tmpl[1]) : null;

  const schemaFile = path.join(paths.schemasDir, "current-status.schema.json");

  // M2: Skill / Instructions もバージョン分離(rev.3)の対象。どの Skill バージョンで
  // 走ったかが分からないと M2.6 の計測が成立しない。
  const step = config.steps[stepId];
  const skillName = step?.skill ?? null;
  const skillPath = skillName ? path.join(paths.skillsDir, skillName, "SKILL.md") : null;
  const instructionNames = [...(step?.instructions ?? []), ...(step?.optionalInstructions ?? [])];
  const instructions = instructionNames
    .map((name) => ({
      name,
      file: path.join(paths.instructionsDir, `${name}.md`),
      version: num((versions.instructions ?? {})[name])
    }))
    .filter((i) => existsSync(i.file))
    .map((i) => ({ name: i.name, version: i.version, hash: sha256File(i.file) }));

  return {
    skill: skillName,
    skillVersion: skillName ? num((versions.skills ?? {})[skillName]) : null,
    skillHash: skillPath ? sha256File(skillPath) : null,
    instructions,
    workflowVersion: num(versions.workflow) ?? num(config.version),
    promptVersion: promptKey ? num(versions.prompts?.[promptKey]) : null,
    promptHash: promptFile ? sha256File(promptFile) : null,
    templateVersion: tmpl ? num(versions.templates?.[tmpl[0]]) : null,
    templateHash: templateFile ? sha256File(templateFile) : null,
    schemaVersion: num(versions.schemas?.currentStatus),
    schemaHash: sha256File(schemaFile)
  };
}
