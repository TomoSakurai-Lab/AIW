import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the engine's bundled assets dir (tools/aiw/assets), used by `aiw init` to scaffold a root.
const here = path.dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = path.resolve(here, "..", "..", "assets");

export const CONFIG_MARKER = path.join("config", "workflow.yaml");

/**
 * ランタイムディレクトリの名前。**エンジン内でこの名前を直書きしてよい唯一の場所。**
 *
 * resolveRoot の探索・フォールバック、`aiw init` の生成先、テストの makeRoot が
 * すべてここを参照する。増やすと「片方だけ直して片方が古い名前を見る」形になり、
 * 検査が黙って空振りする（KI-09 系譜 #11 と同じ壊れ方）。
 */
export const RUNTIME_DIR_NAME = ".ai-workflow2";

/**
 * リネーム移行の検知用。**`RUNTIME_DIR_NAME` とは独立に固定する。**
 *
 * 2026-09 に `.ai-workflow2` → `.ai-workflow` へ改名した。ディレクトリを動かす前に
 * エンジンだけ新名になっていると、resolveRoot は新名を見つけられずフォールバックし、
 * **空のランタイムに対して動き出す**（`aiw init` がそこを埋めてしまう）。
 * それを止めるのが migration guard（下記）。
 *
 * ⚠️ 移行が完全に終わっても消さない。古い環境・古いバックアップから復元したときに
 * 「リネームが要る」と言える経路が無くなる。
 */
export const PRE_RENAME_DIR_NAME = ".ai-workflow2";

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

export type ResolveRootNames = {
  /** 探すランタイム名。既定は RUNTIME_DIR_NAME */
  runtimeDirName?: string;
  /** 改名前の名前。既定は PRE_RENAME_DIR_NAME。migration guard がこれを探す */
  preRenameDirName?: string;
};

/**
 * ランタイムルートを解決する: 明示指定 → AIW_ROOT → config/workflow.yaml を上へ探索
 * → 見つからなければ startDir 直下の `RUNTIME_DIR_NAME`。
 *
 * ⚠️ **見つからないまま素通りさせない場合がある。** 新名が無く、同じ探索路に
 * 改名前の名前（`PRE_RENAME_DIR_NAME`）のランタイムが実在するときは、
 * フォールバックせずに例外を投げる。**リネーム移行が済んでいない環境で
 * 空のランタイムを作らせないため**（`aiw init` がそこを埋めると、
 * 中身の無いランタイムに対して file-exists が素通りする形になる）。
 *
 * 名前を引数で差し替えられるのはテストのため。**既定値は本番と同じ定数**なので、
 * テストがバグと共犯になる形（新旧の名前をテストだけ別に決める）を避けている。
 */
export function resolveRoot(explicit?: string, startDir = process.cwd(), names: ResolveRootNames = {}): string {
  const runtimeDirName = names.runtimeDirName ?? RUNTIME_DIR_NAME;
  const preRenameDirName = names.preRenameDirName ?? PRE_RENAME_DIR_NAME;

  if (explicit) {
    return path.resolve(explicit);
  }
  if (process.env.AIW_ROOT) {
    return path.resolve(process.env.AIW_ROOT);
  }

  let current = path.resolve(startDir);
  const visited: string[] = [];
  while (true) {
    visited.push(current);
    const candidate = path.join(current, runtimeDirName);
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

  // migration guard: 新名が無く、旧名のランタイムが探索路上に実在する
  if (runtimeDirName !== preRenameDirName) {
    for (const dir of visited) {
      const stale = path.join(dir, preRenameDirName);
      if (existsSync(path.join(stale, CONFIG_MARKER))) {
        throw new Error(
          `${preRenameDirName} が見つかりました（${stale}）。リネーム移行が必要です。
` +
            `エンジンは ${runtimeDirName} を探しますが、この環境のランタイムはまだ ${preRenameDirName} です。
` +
            `${preRenameDirName} を ${runtimeDirName} へ改名してから実行してください` +
            `（空のランタイムを作らないため、ここで停止しています）。`
        );
      }
    }
  }

  return path.resolve(startDir, runtimeDirName);
}

// Resolve a path referenced from workflow.yaml (e.g. `schema: schemas/current-status.schema.json`)
// relative to the root, so §12's relative paths hold at runtime.
export function resolveConfigRef(root: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.join(path.resolve(root), ref);
}
