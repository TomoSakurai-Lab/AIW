// Prompt Decomposition（M2）の組み立て機構。
//
// Step プロンプトを「今回のタスク固有の情報」だけへ縮小し、毎回同じ手順は Skill、
// プロジェクト恒久規則は Instructions へ移す。ここはそれらを1つの出力へ戻す処理。
//
// **設計原則: 不在は必ず大きな音を立てる。**
//
// 宣言は workflow.yaml で明示する（`skill:` / `instructions:`）。「ファイルがあれば含める」という
// 規約ベースにしない——ファイルが消えたとき静かに除外されるのは、このコードベースで
// 繰り返してきた同型のバグだから。宣言があるのにファイルが無ければエラーにする。
//
// 唯一の例外が `optionalInstructions`（= local-environment）。環境固有の手順は
// **環境によって存在しないのが正常**なのでエラーにはしない。ただし静かに消すのでもなく、
// 出力の冒頭に `(no <name>.md)` を1行残す。例外を例外として見えるようにするため。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { rootPaths } from "./paths.js";
import type { WorkflowStep } from "./types.js";

export class PromptAssemblyError extends Error {}

/** 結合順序。一般 → 固有。最も具体的な Step 宣言（許可値・出力仕様）を最後に置く。 */
export type AssemblyPart = {
  kind: "instructions" | "local-environment" | "skill" | "step";
  name: string;
  /** ランタイムルートからの相対パス */
  file: string;
  body: string;
};

export type Assembly = {
  text: string;
  parts: AssemblyPart[];
  /** 宣言されていたが存在せず、省略した optional な部品 */
  omitted: string[];
};

function read(file: string): string {
  return readFileSync(file, "utf8").replace(/\s+$/, "");
}

function rel(root: string, file: string): string {
  return path.relative(path.resolve(root), file).replace(/\\/g, "/");
}

export function skillFile(root: string, name: string): string {
  return path.join(rootPaths(root).skillsDir, name, "SKILL.md");
}

export function instructionFile(root: string, name: string): string {
  return path.join(rootPaths(root).instructionsDir, `${name}.md`);
}

export function stepPromptFile(root: string, stepId: string): string {
  return path.join(rootPaths(root).promptsDir, `${stepId}.md`);
}

// 組み立てに参加するファイルを宣言順に並べる。存在確認はしない（呼び出し側の責務）。
export function declaredParts(step: WorkflowStep | undefined): {
  instructions: string[];
  optionalInstructions: string[];
  skill: string | null;
} {
  return {
    instructions: step?.instructions ?? [],
    optionalInstructions: step?.optionalInstructions ?? [],
    skill: step?.skill ?? null
  };
}

/**
 * Skill / Instructions / Step プロンプトを1つの本文へ結合する。
 *
 * step が undefined、あるいは何も宣言していなければ Step プロンプト単体を返す（後方互換）。
 * 宣言があるのにファイルが無ければ PromptAssemblyError を投げる。
 */
export function assembleStepPrompt(root: string, stepId: string, step?: WorkflowStep): Assembly {
  const parts: AssemblyPart[] = [];
  const omitted: string[] = [];
  const decl = declaredParts(step);

  for (const name of decl.instructions) {
    const file = instructionFile(root, name);
    if (!existsSync(file)) {
      throw new PromptAssemblyError(
        `step "${stepId}" declares instructions "${name}" but ${rel(root, file)} does not exist. ` +
          `Create the file or remove the declaration — the prompt is NOT assembled without it.`
      );
    }
    parts.push({ kind: "instructions", name, file: rel(root, file), body: read(file) });
  }

  // 環境固有。不在は正常だが、省略したことは出力に残す。
  for (const name of decl.optionalInstructions) {
    const file = instructionFile(root, name);
    if (!existsSync(file)) {
      omitted.push(`${name}.md`);
      continue;
    }
    parts.push({ kind: "local-environment", name, file: rel(root, file), body: read(file) });
  }

  if (decl.skill) {
    const file = skillFile(root, decl.skill);
    if (!existsSync(file)) {
      throw new PromptAssemblyError(
        `step "${stepId}" declares skill "${decl.skill}" but ${rel(root, file)} does not exist. ` +
          `Create the file or remove the declaration — the prompt is NOT assembled without it.`
      );
    }
    parts.push({ kind: "skill", name: decl.skill, file: rel(root, file), body: read(file) });
  }

  const promptFile = stepPromptFile(root, stepId);
  if (existsSync(promptFile)) {
    parts.push({ kind: "step", name: stepId, file: rel(root, promptFile), body: read(promptFile) });
  } else if (parts.length === 0) {
    // 何も無い。呼び出し側が「専用プロンプトなし」として扱えるよう空で返す。
    return { text: "", parts: [], omitted };
  }

  return { text: render(parts, omitted), parts, omitted };
}

const SEPARATOR = "-".repeat(74);

function heading(part: AssemblyPart): string {
  switch (part.kind) {
    case "instructions":
      return `PROJECT INSTRUCTIONS — ${part.file}`;
    case "local-environment":
      return `LOCAL ENVIRONMENT — ${part.file}`;
    case "skill":
      return `SKILL — ${part.file}`;
    case "step":
      return `STEP — ${part.file}`;
  }
}

function render(parts: AssemblyPart[], omitted: string[]): string {
  // 部品が Step プロンプト1つだけなら、従来と完全に同じ本文を返す（後方互換）。
  if (parts.length === 1 && parts[0].kind === "step" && omitted.length === 0) {
    return parts[0].body;
  }

  const out: string[] = [];
  const manifest = parts.map((p) => p.file).join(" + ");
  out.push(`<!-- assembled by aiw: ${manifest} -->`);
  for (const name of omitted) {
    // 省略を静かに済ませない。環境固有ファイルが無いのは正常だが、無かったことは見せる。
    out.push(`<!-- (no ${name}) — optional, not present in this environment -->`);
  }

  for (const part of parts) {
    out.push("");
    out.push(SEPARATOR);
    out.push(`# ${heading(part)}`);
    out.push(SEPARATOR);
    out.push("");
    out.push(part.body);
  }
  return out.join("\n");
}
