import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rootPaths } from "./paths.js";
import { DEFAULT_ENGINE_STATE, type EngineState } from "./types.js";

export function readState(root: string): EngineState {
  const { stateFile } = rootPaths(root);
  if (!existsSync(stateFile)) {
    return { ...DEFAULT_ENGINE_STATE };
  }
  let raw: string;
  try {
    raw = readFileSync(stateFile, "utf8");
  } catch (error) {
    throw new Error(`Could not read state.json: ${asMessage(error)}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EngineState>;
    return { ...DEFAULT_ENGINE_STATE, ...parsed };
  } catch (error) {
    throw new Error(`state.json is not valid JSON: ${asMessage(error)}`);
  }
}

// Atomic write (tmp file + rename) so a crash mid-write cannot corrupt state.json.
export function writeState(root: string, state: EngineState): void {
  const { stateFile } = rootPaths(root);
  mkdirSync(path.dirname(stateFile), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, stateFile);
}

export function updateState(root: string, patch: Partial<EngineState>): EngineState {
  const next = { ...readState(root), ...patch };
  writeState(root, next);
  return next;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
