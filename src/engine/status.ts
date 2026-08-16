import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Status } from "./types.js";

export function statusPath(root: string, statusFile: string): string {
  return path.join(path.resolve(root), statusFile);
}

// Reads and JSON-parses current-status.json. Returns null if absent; throws on malformed JSON.
export function readStatus(root: string, statusFile: string): Status | null {
  const file = statusPath(root, statusFile);
  if (!existsSync(file)) {
    return null;
  }
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${statusFile} is not valid JSON: ${message}`);
  }
  return parsed as Status;
}
