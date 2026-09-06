// 承認ゲートの判断材料（2026-09-06）。
//
// **表示だけの機構**なので、判定へ影響しないことと、
// **validator が見ていない事実を人間へ届けること**の2点を固定する。
//
// 実測（2026-09-06）: 前タスクの current-task.md が残ったまま承認待ちになり、
// file-exists も artifact-contract も通り、reject → run の再実行でも同じ古いファイルが
// 再検証された。「古い成果物」はどの validator も見ていない——だからここで出す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildBriefing, formatBriefing, REQUEST_FILE } from "../src/engine/briefing.js";
import { resetForNewTask, runStep } from "../src/engine/engine.js";
import { readState } from "../src/engine/state.js";
import { rootPaths } from "../src/engine/paths.js";
import { makeRoot, writeIn, writeStatus } from "./helpers.js";

/** ファイルの更新時刻を秒単位でずらす（鮮度の前後関係を作るため）。 */
function setMtime(file: string, secondsFromNow: number): void {
  const t = new Date(Date.now() + secondsFromNow * 1000);
  utimesSync(file, t, t);
}

// Test 143 — **依頼より古い成果物を名指しする。** 三値（古い / 新しい / 判定不能）を潰さない。
test("143: the briefing names artifacts that predate the request, and says so when it cannot tell", () => {
  const { root, config } = makeRoot();
  writeIn(root, REQUEST_FILE, "# User Task\n\n工種ツリーに排他制御を追加する\n");
  writeStatus(root, { step: "task-planning", result: "planned", reason: "前タスクの計画" });

  const taskFile = path.join(root, "current-task.md");
  writeFileSync(taskFile, "# Task\n\n## Goal\n\n- 別タスクの目的\n", "utf8");

  // 成果物のほうが古い = 前タスクの残骸
  setMtime(path.join(root, REQUEST_FILE), 0);
  setMtime(taskFile, -3600);

  const stale = buildBriefing(root, config, "task-planning");
  const staleTask = stale.freshness.find((f) => f.file === "current-task.md");
  assert.equal(staleTask?.olderThanRequest, true);
  assert.match(formatBriefing(stale), /current-task\.md.*依頼より古い/);
  assert.match(formatBriefing(stale), /今回の依頼のものか確かめること/);

  // AI の言い分（result / reason）も出す。executor 化で消えた「まとめ」の代わり
  assert.equal(stale.declared?.result, "planned");
  assert.match(formatBriefing(stale), /reason: 前タスクの計画/);

  // 依頼より新しければ警告しない
  // ⚠️ **そのステップの成果物を全部新しくする。** current-status.json も出力なので、
  // 片方だけ新しくしても警告は消えない（=「1つでも古ければ言う」という意図どおりの挙動）。
  setMtime(taskFile, 3600);
  setMtime(path.join(root, "current-status.json"), 3600);
  const fresh = buildBriefing(root, config, "task-planning");
  assert.equal(fresh.freshness.find((f) => f.file === "current-task.md")?.olderThanRequest, false);
  assert.equal(/依頼より古い/.test(formatBriefing(fresh)), false);

  // ⚠️ 依頼ファイルが無ければ **null（判定不能）**。false（＝新しい）へ潰さない
  rmSync(path.join(root, REQUEST_FILE), { force: true });
  const blind = buildBriefing(root, config, "task-planning");
  assert.equal(blind.requestMtimeMs, null);
  assert.equal(blind.freshness.find((f) => f.file === "current-task.md")?.olderThanRequest, null);
  assert.match(formatBriefing(blind), /依頼と比較できない/);
});

// Test 144 — **見出しの一覧は artifacts の契約から引く。** 別の一覧を手書きしない。
//
// 契約に見出しを足したら、この表示も自動で追随する（契約の二重管理を作らない）。
test("144: the outline follows the artifact contract, and keeps absent apart from empty", () => {
  const { root, config } = makeRoot();
  writeIn(root, REQUEST_FILE, "# User Task\n\n依頼\n");
  writeIn(
    root,
    "current-task.md",
    ["# Task", "", "## Goal", "", "本文だけで箇条書きは無い", "", "## Scope", "", "- a", "- b", ""].join("\n")
  );

  const b = buildBriefing(root, config, "task-planning");
  const outline = b.outlines.find((o) => o.file === "current-task.md");
  assert.ok(outline, "current-task.md は markdown-sections 契約を持つ");

  const declared = config.artifacts["current-task"].contract as { sections: string[] };
  assert.deepEqual(
    outline!.sections.map((s) => s.section),
    declared.sections.filter((s) => !s.startsWith("### ")),
    "宣言された見出しをそのまま並べる（### は畳む）"
  );

  const at = (name: string) => outline!.sections.find((s) => s.section === name);
  assert.equal(at("## Scope")?.items, 2);
  assert.equal(at("## Goal")?.items, 0, "本文だけの節は 0 件");
  assert.equal(at("## Requirements")?.items, null, "**無い見出しは null。0 件ではない**");
  assert.match(formatBriefing(b), /"-" は見出しが無い/);

  // 入れ物（下位見出しを含む節）の件数は子の合計になるので数字を出さない
  assert.equal(at("# Task")?.container, true);
  assert.match(formatBriefing(b), /# Task\s+…/);

  // 契約が無い成果物（current-status.json は json-schema 契約）は outline を作らない
  assert.equal(b.outlines.some((o) => o.file === "current-status.json"), false);
  // ただし鮮度は出す（成果物であることに変わりはない）
  assert.ok(b.freshness.some((f) => f.file === "current-status.json"));
});

// Test 145 — **表示は判定に影響しない。** state.json も Event Log も触らない。
test("145: building the briefing writes nothing", () => {
  const { root, config } = makeRoot();
  writeIn(root, REQUEST_FILE, "# User Task\n\n依頼\n");
  const { stateFile } = rootPaths(root);
  const before = readFileSync(stateFile, "utf8");

  buildBriefing(root, config, "task-planning");
  buildBriefing(root, config, "review");

  assert.equal(readFileSync(stateFile, "utf8"), before, "state.json を書かない");
});

// Test 146 — **`aiw new-task` は current-status.json を削除する。** テンプレートで埋めない。
//
// 実測（2026-09-04）: 前タスクの宣言が残ったまま新しい依頼を書いて run したところ、
// 残骸がたまたま `"step": "task-planning"` だったので preflight の一致検査を素通りし、
// **古い計画が承認ゲートまで到達した**。task-metadata.json と同じ扱い（削除）にして、
// 「まだ誰も宣言していない」を**不在**で表す。空テンプレートでは step が一致すれば通ってしまう。
test("146: a new task discards the previous status declaration instead of restoring a template", () => {
  const { root, config } = makeRoot();
  writeStatus(root, { step: "task-planning", result: "planned", reason: "前タスクの残骸" });
  writeIn(root, "scope-violation-report.md", "old report");
  writeIn(root, "current-task.md", "# Task\n\n前タスクの計画\n");

  const { restored, discarded } = resetForNewTask(root, config);

  assert.equal(existsSync(path.join(root, "current-status.json")), false, "**残さない**（消す）");
  assert.ok(discarded.includes("current-status.json"), "消したことを黙らせない（呼び出し側が表示する）");
  assert.ok(discarded.includes("scope-violation-report.md"));
  // 作業ドキュメントのほうは従来どおりテンプレートへ戻す
  assert.ok(restored.includes("current-task.md"));
  assert.equal(readFileSync(path.join(root, "current-task.md"), "utf8").includes("前タスクの計画"), false);

  // 状態は task-planning の ready へ戻っている（**halt を起こす前に見る**）
  assert.equal(readState(root).currentStep, "task-planning");
  assert.equal(readState(root).status, "ready");

  // ⚠️ 消した後は file-exists が **ファイル名を挙げて** 止める＝原因が読める形の失敗になる。
  // （宣言が残っていれば preflight は step 一致だけで通ってしまう。だから消す）
  const outcome = runStep(root, config, "task-planning");
  assert.equal(outcome.kind, "halted");
  assert.match(String((outcome as any).message ?? ""), /current-status\.json/);
});
