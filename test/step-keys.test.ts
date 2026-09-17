// 効かないステップ設定キーの検出（BL-219・KI-09 系譜 #15・2026-09-17）。
//
// `steps.<id>.model` / `effort` / `bashAllow` は claude executor だけが読む。codex / clipboard のステップに書いても
// ローダーは黙って受け入れていた——「宣言はあるが効いていない」の 15 例目。
//
// ここで固定すること:
//   - executor 固有キーの表は EXECUTOR_STEP_KEYS の 1 箇所。**表と executor の実装がずれていない**
//   - 効かないキーは config.ineffectiveStepKeys に集まる（CLI が deprecations と同じ経路で表示する）
//   - ⚠️ **ロード時エラーにしない**: claude のステップを executor の 1 行だけ clipboard へ戻しても読める（不変条件5）
//   - 出荷する assets は効かないキーを含まない
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflow } from "../src/engine/loader.js";
import { rootPaths } from "../src/engine/paths.js";
import { EXECUTOR_STEP_KEYS } from "../src/engine/types.js";
import { makeRoot } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (name: string): string => readFileSync(path.join(here, "..", "src", "engine", "executors", `${name}.ts`), "utf8");

/** assets から init した root の workflow.yaml を書き換えて読み直す。 */
function loadEdited(edit: (yaml: string, eol: string) => string) {
  const { root } = makeRoot();
  const file = rootPaths(root).workflowYaml;
  const text = readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const edited = edit(text, eol);
  assert.notEqual(edited, text, "書き換えのアンカーが assets に見つかること");
  writeFileSync(file, edited, "utf8");
  return loadWorkflow(root);
}

// Test 178 — 表と実装がずれていない。表に載せたキーはその executor の実装が `step.<key>` として読み、他の executor は読まない。
test("178: the executor-specific key table matches what each executor actually reads", () => {
  for (const [executor, keys] of Object.entries(EXECUTOR_STEP_KEYS)) {
    for (const key of keys) {
      assert.match(source(executor), new RegExp(`step\\.${key}\\b`), `${executor}.ts が step.${key} を読む`);
      for (const other of Object.keys(EXECUTOR_STEP_KEYS).filter((e) => e !== executor)) {
        assert.doesNotMatch(source(other), new RegExp(`step\\.${key}\\b`), `${other}.ts は step.${key} を読まない（読むなら表を直す）`);
      }
    }
  }
});

// Test 179 — codex のステップに claude 専用キーを書くと、ロードは通るが効かないキーとして列挙される。
test("179: claude-only keys on a codex step are listed as ineffective instead of being silently accepted", () => {
  const config = loadEdited((y, eol) =>
    y.replace(
      `  implementation:${eol}    role: codex${eol}`,
      `  implementation:${eol}    role: codex${eol}    executor: codex${eol}    model: gpt-x${eol}    effort: high${eol}`
    )
  );
  assert.equal(config.steps["implementation"].executor, "codex");
  assert.equal(config.ineffectiveStepKeys?.length, 2);
  assert.match(config.ineffectiveStepKeys![0], /steps\.implementation\.model は executor "codex" では読まれない（読むのは claude だけ）/);
  assert.match(config.ineffectiveStepKeys![1], /steps\.implementation\.effort/);
});

// Test 180 — ⚠️ **ロード時エラーにしない理由**: claude のステップを executor の 1 行だけ clipboard へ戻しても読める（不変条件5）。
// claude のままなら何も列挙されない。
test("180: rolling a claude step back to clipboard by one line still loads, and only then are its keys listed", () => {
  const review = (executor: string) => (y: string, eol: string) =>
    y.replace(
      `  review:${eol}    role: claude${eol}`,
      `  review:${eol}    role: claude${eol}${executor}    effort: high${eol}    bashAllow:${eol}      - "git diff:*"${eol}`
    );

  const asClaude = loadEdited((y, eol) => review(`    executor: claude${eol}`)(y, eol));
  assert.equal(asClaude.ineffectiveStepKeys, undefined, "claude のステップでは効くキーなので列挙しない");

  const rolledBack = loadEdited(review("")); // executor の行だけを消した（既定は clipboard）
  assert.equal(rolledBack.steps["review"].executor, "clipboard");
  assert.equal(rolledBack.ineffectiveStepKeys?.length, 2, "エラーではなく列挙");
  assert.match(rolledBack.ineffectiveStepKeys!.join("\n"), /steps\.review\.bashAllow は executor "clipboard" では読まれない/);

  // 出荷する assets はそのままで効かないキーを含まない
  assert.equal(makeRoot().config.ineffectiveStepKeys, undefined);
});
