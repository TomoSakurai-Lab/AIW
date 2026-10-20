// 小枠A（2026-10-19・docs/design-reflection.md）: その場で書き換えるファイルのスナップショット・知識の差分サマリ・承認ゲート・却下での戻し。
//
// assets の既定（reflection は clipboard）で回す——スナップショットと差分とゲートと戻しは executor に依存しない（clipboard でも残る・不変条件5）。
// 故障注入の一周（人間の指定）: 却下 → 退避 → 戻し → 再実行 → 差分が初回と独立。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { runAuto } from "../src/engine/auto.js";
import { approve, reject, resetForNewTask, runStep } from "../src/engine/engine.js";
import { readEventLog } from "../src/engine/observed.js";
import { rootPaths } from "../src/engine/paths.js";
import type { WorkflowConfig } from "../src/engine/types.js";
import { makeRoot, seedReflectionOutputs, setStep, writeIn, writeStatus } from "./helpers.js";

const BL_900 = "\n## BL-900\n\n- Source: テスト\n- Severity: Minor\n- Trigger: すぐ\n- Summary: 新しい積み残し\n- Status: open\n";

/** improve-check → reflection の遷移を本物で踏む（入るときのスナップショット） */
function enterReflection(root: string, config: WorkflowConfig): void {
  setStep(root, "improve-check", { fixAttempts: 1 });
  writeStatus(root, { step: "improve-check", result: "ready-for-reflection", reason: "x" });
  const o = runStep(root, config, "improve-check");
  assert.equal((o as any).to, "reflection");
}

/** reflection の仕事の代わり: 学びを1行・BL を1件足し、task-metadata と status を書く */
function writeReflection(root: string, extra: { learning?: string; backlog?: string } = {}): void {
  const learnings = path.join(root, "learnings.md");
  writeIn(root, "learnings.md", readFileSync(learnings, "utf8") + (extra.learning ?? "\n- 学び: スナップショットは宣言から導く\n"));
  writeIn(root, "backlog.md", readFileSync(path.join(root, "backlog.md"), "utf8") + (extra.backlog ?? BL_900));
  seedReflectionOutputs(root);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });
}

function events(root: string, type: string): any[] {
  const log = readEventLog(root);
  assert.ok(Array.isArray(log));
  return (log as any[]).filter((r) => r.event === type);
}

const snapDir = (root: string, step = "reflection") => path.join(rootPaths(root).runsDir, "snapshots", step);

// Test 251 — 入るときに、宣言から導いた「その場で書き換えるファイル」だけを撮る（知識ファイルの名前はエンジンに無い）
test("251: entering reflection snapshots exactly the in-place files derived from the declarations", () => {
  const { root, config } = makeRoot();
  enterReflection(root, config);
  const manifest = JSON.parse(readFileSync(path.join(snapDir(root), "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.targets.map((t: any) => t.path),
    ["context.md", "learnings.md", "backlog.md", "research/"],
    "inputs ∩ (outputs ∪ optionalOutputs)。task-metadata.json / current-status.json は入らない"
  );
  assert.equal(readFileSync(path.join(snapDir(root), "files", "learnings.md"), "utf8"), readFileSync(path.join(root, "learnings.md"), "utf8"));
  const ev = events(root, "snapshot.captured").pop();
  assert.equal(ev.step, "reflection");
});

// Test 252 — 差分サマリ: 承認待ちで止まり、異常候補を先頭に、ファイルごとの増減と BL の追加が出る。異常があれば先頭に並ぶ
test("252: the knowledge diff lists anomalies first, then per-file changes and backlog changes, and gates the step", async () => {
  const { root, config } = makeRoot();
  enterReflection(root, config);
  writeReflection(root);
  const out = runStep(root, config, "reflection");
  assert.equal(out.kind, "awaiting-approval", "承認ゲート（知識の差分を見て承認）");
  const diff = (out as any).knowledgeDiff;
  assert.match(diff.line, /^異常候補なし \/ /);
  assert.deepEqual(diff.bl.added, ["BL-900"]);
  assert.ok(diff.files.some((f: any) => f.path === "learnings.md" && f.added >= 1));
  const md = readFileSync(path.join(root, diff.report), "utf8");
  assert.ok(md.indexOf("## 異常候補") < md.indexOf("## ファイルごとの増減"), "異常候補が先頭");
  assert.match(md, /- 異常候補なし/);
  assert.equal(events(root, "knowledge.diff").length, 1);

  // auto の停止の1行にも要約が載る（A1）
  const r = await runAuto(root, config, {});
  assert.equal(r.condition, "A1");
  assert.match(r.line, /⏸ 承認待ち: reflection — 知識の差分（異常候補なし \/ .*BL 追加 BL-900）を見て aiw approve/);

  // 異常候補: 同じ BL の二重・既存の BL の消失
  const { root: r2, config: c2 } = makeRoot();
  writeIn(r2, "backlog.md", readFileSync(path.join(r2, "backlog.md"), "utf8") + BL_900.replace("BL-900", "BL-901"));
  enterReflection(r2, c2);
  writeReflection(r2, { backlog: BL_900 + BL_900 });
  writeIn(r2, "backlog.md", readFileSync(path.join(r2, "backlog.md"), "utf8").replace(/\n## BL-901[\s\S]*?- Status: open\n/, "\n"));
  const o2 = runStep(r2, c2, "reflection");
  const d2 = (o2 as any).knowledgeDiff;
  assert.match(d2.line, /^⚠️ 異常候補 \d+ 件/);
  assert.ok(d2.anomalies.some((a: string) => /BL-900 が二重にある/.test(a)));
  assert.ok(d2.anomalies.some((a: string) => /既存の BL-901 が消えた/.test(a)));
});

// Test 253 — 故障注入の一周: 却下 → 退避 → 戻し → 再実行 → 差分が初回と独立（追記が二重にならない）。承認で archive へ随伴し、runs/ は消える
test("253: reject saves the edited state, restores the snapshot, and the rerun's diff is independent of the first", () => {
  const { root, config } = makeRoot();
  enterReflection(root, config);
  const before = readFileSync(path.join(root, "backlog.md"), "utf8");

  writeReflection(root);
  const first = (runStep(root, config, "reflection") as any).knowledgeDiff;
  // 人が却下の前に手で直した分（退避先から救えること）
  writeIn(root, "learnings.md", readFileSync(path.join(root, "learnings.md"), "utf8") + "- 人の手直し\n");

  const rej = reject(root, config, "学びの書き方を直す");
  assert.equal(rej.kind, "rerun");
  assert.equal(readFileSync(path.join(root, "backlog.md"), "utf8"), before, "スナップショットへ戻った");
  const restored = events(root, "knowledge.restored").pop();
  const saved = path.join(root, restored.savedTo);
  assert.match(readFileSync(path.join(saved, "learnings.md"), "utf8"), /人の手直し/, "退避（削除ではない）: 人の手直しも残っている");
  assert.match(readFileSync(path.join(saved, "backlog.md"), "utf8"), /## BL-900/);

  // 再実行（同じ仕事をもう一度）
  writeReflection(root);
  const second = (runStep(root, config, "reflection") as any).knowledgeDiff;
  assert.deepEqual(second.files, first.files, "差分が初回と同じ（前回の追記の上に重ならない）");
  assert.deepEqual(second.bl, first.bl);
  assert.equal((readFileSync(path.join(root, "backlog.md"), "utf8").match(/## BL-900/g) ?? []).length, 1, "BL が二重にならない");
  assert.equal(second.anomalies.length, 0);

  // 承認 → archive へ随伴・runs/snapshots は消える
  const ok = approve(root, config);
  assert.equal(ok.kind, "transitioned");
  const archiveRoot = path.join(rootPaths(root).archiveDir, "single");
  const task = readdirSync(archiveRoot).sort().pop()!;
  const archived = readdirSync(path.join(archiveRoot, task));
  assert.ok(archived.includes("knowledge-diff-reflection.md"), "差分サマリはタスクの記録");
  assert.ok(archived.some((n) => /^knowledge-reflection-rejected-/.test(n)), "却下で退避した状態もタスクの記録");
  assert.equal(existsSync(path.join(rootPaths(root).runsDir, "snapshots")), false, "runs/snapshots は archive の後で消える");
});

// Test 254 — 2 タスク連続（new-artifact-checklist の 2 周目）: それぞれの差分が別々に残る。
// あわせて、claude のとき 0 バイトのスタブのまま task-metadata.json が書かれなければ「空」と言って止まる
test("254: two tasks in a row keep separate knowledge diffs; an unwritten task-metadata stub halts as empty", async () => {
  const { root, config } = makeRoot();
  for (const n of [1, 2]) {
    if (n === 2) {
      // archive の退避先は秒単位の時刻で分かれる（Test 27b と同じ前提）。同じ秒に 2 件を archive しない
      await new Promise((r) => setTimeout(r, 1100));
      resetForNewTask(root, config);
    }
    enterReflection(root, config);
    writeReflection(root, { learning: `\n- 学び: タスク ${n}\n`, backlog: BL_900.replace("BL-900", `BL-90${n}`) });
    assert.equal(runStep(root, config, "reflection").kind, "awaiting-approval");
    assert.equal(approve(root, config).kind, "transitioned");
  }
  const archiveRoot = path.join(rootPaths(root).archiveDir, "single");
  const tasks = readdirSync(archiveRoot).filter((t) => existsSync(path.join(archiveRoot, t, "knowledge-diff-reflection.md"))).sort();
  assert.equal(tasks.length, 2, "2 件目が 1 件目を上書きしない");
  assert.match(readFileSync(path.join(archiveRoot, tasks[0], "knowledge-diff-reflection.md"), "utf8"), /BL-901/);
  assert.match(readFileSync(path.join(archiveRoot, tasks[1], "knowledge-diff-reflection.md"), "utf8"), /BL-902/);

  // claude の reflection: 入るときに task-metadata.json の 0 バイトスタブ。書かれなければ json-schema が「空」で止める
  const { root: r2, config: c2 } = makeRoot();
  const claude = { ...c2, steps: { ...c2.steps, reflection: { ...c2.steps.reflection, executor: "claude" as const } } };
  enterReflection(r2, claude);
  assert.equal(statSync(path.join(r2, "task-metadata.json")).size, 0, "Edit のためのスタブ");
  writeStatus(r2, { step: "reflection", result: "feature-complete", reason: "x" });
  const halted = runStep(r2, claude, "reflection");
  assert.equal(halted.kind, "halted");
  assert.match((halted as any).message, /task-metadata\.json is empty \(no one wrote it/);
});

// Test 257 — 2026-10-20: feature-continue で nextPhaseId を書き漏らしたとき、halt の文言に feature.md から正解の候補を出す（表示だけ・判定は同じ halt）。
// あわせて、research/ のファイル名に git の引用符が残らない（knowledge-diff の表示の不具合）
test("257: a missing nextPhaseId halts with the next phase suggested from feature.md, and research/ files are labelled cleanly", () => {
  const { root, config } = makeRoot();
  writeIn(root, "feature.md", "# Feature: FEAT-x\n\n## Phase list\n\n- `p1`: one\n- `p2`: two\n\nCurrent phase: p1\n");
  enterReflection(root, config);
  writeIn(root, "research/note.md", "# memo\n- new\n");
  writeReflection(root);
  writeStatus(root, { step: "reflection", result: "feature-continue", reason: "x" }); // nextPhaseId を書き漏らした
  const out = runStep(root, config, "reflection");
  assert.equal(out.kind, "halted");
  assert.match((out as any).message, /nextPhaseId/);
  assert.match((out as any).message, /feature\.md の Current phase は p1。次の Phase ID は p2——current-status\.json に "nextPhaseId": "p2" を足して aiw resume/);

  const diff = events(root, "knowledge.diff").pop();
  const research = diff.files.find((f: any) => f.path.startsWith("research/"));
  assert.ok(research, "research/ の新しいファイルも差分に出る");
  assert.equal(research.path, "research/note.md", "引用符や {a => b} が残らない");
});
