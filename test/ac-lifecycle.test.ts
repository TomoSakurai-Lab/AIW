// ac-manifest.json / ac-result.json のライフサイクル（KI-09 系譜 #10 / BL-101 の恒久対応）。
//
// ソーク窓の実測: archive 直近 3 件の ac-* は **0 件**。退避対象に入っておらず、
// runtime に前タスクのものが残り続けていた。つまり
//   (1) タスクごとの計測記録が残らない（後から失敗を追えない = M7 の目的が崩れる）
//   (2) 次タスクが前タスクの計画を引き継いだように見える
// の 2 つが同時に起きていた。
//
// 修正の形は task-metadata.json と同じ: **archive してから削除**（restoreTemplates ではない）。
// 空テンプレを置くと file-exists / json-schema が中身の無いファイルで素通りする。
//
// ⚠️ このテストが見るのは「2 タスク連続で、それぞれの ac-* が別々に残ること」。
// KI-09 系譜 #4 / KI-02（archive 先が毎回同じパスに解決され ~30 タスク分が消えた）の教訓で、
// 1 タスクだけ通しても「2 件目が 1 件目を上書きする」形の欠陥は捕まらない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runStep } from "../src/engine/engine.js";
import { archivedTaskDirs, makeRoot, seedReflectionOutputs, setStep, writeIn, writeStatus } from "./helpers.js";

const AC_FILES = ["ac-manifest.json", "ac-result.json"] as const;

// 1 タスク分の reflection を通す。taskId は退避先ディレクトリ名の一部になる。
function runReflection(root: string, config: Parameters<typeof runStep>[1], taskId: string, marker: string): void {
  setStep(root, "reflection", { taskId });
  seedReflectionOutputs(root);
  writeIn(root, "ac-manifest.json", JSON.stringify({ acceptanceCriteria: [{ id: marker, evidenceKind: "file" }] }));
  writeIn(root, "ac-result.json", JSON.stringify({ results: [{ id: marker, status: "passed" }] }));
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });

  const o = runStep(root, config, "reflection");
  assert.equal(o.kind, "transitioned", `reflection(${taskId}) が遷移しない`);
}

test("ac lifecycle: two consecutive tasks archive their own ac-* and leave none behind", () => {
  const { root, config } = makeRoot();

  runReflection(root, config, "task-a", "AC-A");
  for (const f of AC_FILES) {
    assert.equal(existsSync(path.join(root, f)), false, `${f} は退避後に runtime から消える`);
  }

  runReflection(root, config, "task-b", "AC-B");

  // ⚠️ **退避先が 2 つあること**を先に見る。1 つしか無ければ 2 件目が 1 件目を
  // 上書きしており、中身の照合をいくらしても意味がない（KI-02 がそれで生き延びた）。
  const dirs = archivedTaskDirs(root);
  assert.equal(dirs.length, 2, "タスクごとに別の退避先");

  const found = new Map<string, string>();
  for (const d of dirs) {
    for (const f of AC_FILES) {
      const p = path.join(path.resolve(root), "archive", "single", d, f);
      assert.ok(existsSync(p), `${d}/${f} が退避されていない`);
      found.set(`${d}/${f}`, readFileSync(p, "utf8"));
    }
  }

  const manifests = [...found.entries()].filter(([k]) => k.endsWith("ac-manifest.json")).map(([, v]) => v);
  assert.ok(manifests.some((m) => m.includes("AC-A")), "task-a の manifest が残る");
  assert.ok(manifests.some((m) => m.includes("AC-B")), "task-b の manifest が残る");

  for (const f of AC_FILES) {
    assert.equal(existsSync(path.join(root, f)), false, `${f} は 2 タスク目の後も runtime に残らない`);
  }
});

// discardAcArtifacts は「宣言はあるが効いていない」になりやすい形（postAction は
// workflow.yaml 側の並び順で呼ばれる）。**出荷する workflow.yaml に載っていること**を見る。
test("ac lifecycle: discardAcArtifacts is declared in the shipped reflection postActions", () => {
  const { root, config } = makeRoot();
  const actions = config.steps["reflection"].postActions ?? [];
  assert.ok(actions.includes("discardAcArtifacts"), "reflection の postActions に宣言が無い");
  assert.ok(
    actions.indexOf("archiveArtifacts") < actions.indexOf("discardAcArtifacts"),
    "**退避より先に削除してはいけない**（記録ごと消える）"
  );
  assert.ok(existsSync(path.join(root, "config", "workflow.yaml")));
});
