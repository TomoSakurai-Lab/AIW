// 設定キーの中立化（2026-09-17・M4.4 の判定で昇格した唯一の共通化）。
//
// `codexTimeoutMs` / `codexIdleTimeoutMs` は、エンジンが claude のステップでも読んでいた「実質共通のキー」だった。
// 中立名（executorTimeoutMs / executorIdleTimeoutMs）へ揃え、未使用の `claudeTimeoutMs` 宣言は削除した。
//
// ここで固定するのは**移行の形**:
//   - 旧キーは 1 世代の間だけ読み替える。**黙って既定値に落とさない**（即削除すると既存 runtime がそうなる）
//   - 読み替えたら deprecation を残す（CLI が表示する）
//   - 新旧が両方あれば新キーが勝ち、旧キーを「無視した」と知らせる
//   - 削除したキーは「効果が無い」と知らせる（黙って無視しない）
//   - 出荷する assets は旧キーを使わない
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execStep } from "../src/engine/engine.js";
import type { ExecutorRequest, StepExecutor } from "../src/engine/executors/types.js";
import { loadWorkflow, migrateSettings } from "../src/engine/loader.js";
import { readEventLog } from "../src/engine/observed.js";
import { rootPaths } from "../src/engine/paths.js";
import { makeRoot, setStep } from "./helpers.js";

/** assets から init した root の workflow.yaml の settings 先頭へ行を差し込んで読み直す。 */
function loadWithSettings(lines: string[]): { root: string; config: ReturnType<typeof loadWorkflow> } {
  const { root } = makeRoot();
  const file = rootPaths(root).workflowYaml;
  const text = readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const anchor = `settings:${eol}`;
  assert.ok(text.includes(anchor), "assets の workflow.yaml に settings: がある前提");
  writeFileSync(file, text.replace(anchor, `${anchor}${lines.map((l) => `  ${l}${eol}`).join("")}`), "utf8");
  return { root, config: loadWorkflow(root) };
}

// Test 165 — 旧キーだけの runtime は、値が**そのまま効く**（黙って既定値に落ちない）+ deprecation が残る。
test("165: legacy codex* timeout keys keep working for one generation, and say so", async () => {
  const { root, config } = loadWithSettings(["codexTimeoutMs: 1234000", "codexIdleTimeoutMs: 456000"]);

  assert.equal(config.settings.executorTimeoutMs, 1234000);
  assert.equal(config.settings.executorIdleTimeoutMs, 456000);
  assert.equal(config.settings.codexTimeoutMs, undefined, "読み替え後の旧キーは残さない（読む場所を 1 つにする）");
  assert.equal(config.settings.codexIdleTimeoutMs, undefined);
  assert.equal(config.deprecations?.length, 2);
  assert.match(config.deprecations![0], /codexTimeoutMs.*executorTimeoutMs.*読み替えた/);
  assert.match(config.deprecations![1], /codexIdleTimeoutMs.*executorIdleTimeoutMs.*読み替えた/);

  // エンジンまで通して、見張りが旧キーの値で動くこと（ここが「黙って既定値に落ちない」の本体）
  setStep(root, "implementation");
  const seen: Array<number | undefined> = [];
  const probe: StepExecutor = {
    name: "codex",
    async execute(req: ExecutorRequest) {
      seen.push(req.timeoutMs);
      return { ok: true, outputs: [] };
    }
  };
  await execStep(root, config, "implementation", { executor: probe });
  assert.deepEqual(seen, [1234000]);
  const log = readEventLog(root);
  assert.ok(Array.isArray(log));
  const started = (log as Array<Record<string, any>>).filter((r) => r.event === "exec.started").pop();
  assert.deepEqual(started?.meta, { totalTimeoutMs: 1234000, idleTimeoutMs: 456000 });
});

// Test 166 — 新旧が両方あれば新キーが勝つ。旧キーは「無視した」と知らせる。
test("166: when both names are present the neutral key wins and the legacy one is reported as ignored", () => {
  const { config } = loadWithSettings(["executorTimeoutMs: 2000000", "codexTimeoutMs: 9000000"]);
  assert.equal(config.settings.executorTimeoutMs, 2000000);
  assert.equal(config.settings.codexTimeoutMs, undefined);
  assert.equal(config.deprecations?.length, 1);
  assert.match(config.deprecations![0], /codexTimeoutMs.*無視した/);
});

// Test 167 — 削除した claudeTimeoutMs は「効果が無い」と知らせる。新キーだけなら deprecation は出ない。
test("167: the removed claudeTimeoutMs is reported as having no effect, and clean settings report nothing", () => {
  const removed = loadWithSettings(["claudeTimeoutMs: 1000"]).config;
  assert.equal((removed.settings as Record<string, unknown>).claudeTimeoutMs, undefined);
  assert.equal(removed.deprecations?.length, 1);
  assert.match(removed.deprecations![0], /claudeTimeoutMs は効果が無い/);

  const clean = loadWithSettings(["executorTimeoutMs: 3600000", "executorIdleTimeoutMs: 900000"]).config;
  assert.equal(clean.deprecations, undefined, "deprecation が無ければキーごと無い");

  // migrateSettings は入力を変更しない（呼び出し側の parsed を壊さない）
  const input = { codexTimeoutMs: 5 };
  migrateSettings(input);
  assert.deepEqual(input, { codexTimeoutMs: 5 });
});

// Test 168 — 出荷する assets は旧キーを使わない（新環境が最初から deprecation を踏まない）。
test("168: the shipped workflow.yaml loads without deprecations", () => {
  const { config } = makeRoot();
  assert.equal(config.deprecations, undefined);
});
