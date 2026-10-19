// 小枠B（2026-10-19・docs/design-task-planning.md）: task-planning の整形契約と executor 化。
//
// request-mapping validator が縛るのは**表の完全性**だけ（measurement-completeness と同じ型）。内容の妥当性はゲート①で人間が見る。
// 契約の故障注入は人間の指定どおり3ケース: 写像漏れ / 架空 ID / 依頼にない要件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resetForNewTask, runStep } from "../src/engine/engine.js";
import { readEventLog } from "../src/engine/observed.js";
import { rootPaths } from "../src/engine/paths.js";
import { checkRequestMapping } from "../src/engine/requestMapping.js";
import type { WorkflowConfig } from "../src/engine/types.js";
import { makeRoot, setStep, writeIn, writeStatus } from "./helpers.js";

/** 実物（archive/single/20261019T005106-task の current-task.md）を新しい書式へ写した fixture */
const REAL_TASK = [
  "# Task",
  "",
  "- Task ID: TASK-2026-10-16-motodumori-ref-appgrid",
  "- 拾う Backlog: `BL-338`、`BL-339`",
  "",
  "## Goal",
  "",
  "元積内訳参照ダイアログの明細の表を `AppGrid` にし、他の表と同じ基本仕様にそろえる。",
  "",
  "## Scope",
  "",
  "- 明細の表を `AppGrid` へ置き換える",
  "",
  "## Requirements",
  "",
  "- R1: 列構成・列幅・表示形式・費消の色分け・合計行・空表示は今と同じにする",
  "- R2: 読み取り専用。編集・貼付は無し。行頭列は出さない",
  "- R3: 表ごとに変えてよいのは見た目・列数・スクロール固定の列数だけ",
  "- R4: セル内の文字選択を廃止してよいかを調べる（決まらなければ Open Decisions へ）",
  "- R5: `BL-339` の互換用の別名を片付ける",
  "- R6: build・単体テスト・フル e2e を壊さない",
  "",
  "## Out of Scope",
  "",
  "- O1: 上の表（既に `AppGrid`）の変更",
  "",
  "## Acceptance Criteria",
  "",
  "- AC-01: 明細の表が `AppGrid` で描かれ、生の `AgGridReact` が無い",
  "- AC-02: 列・表示形式・色分け・合計行が変更前と同じ",
  "",
  "## Request Mapping",
  "",
  "| # | 依頼（user-task.md の箇所と要旨） | 写像先 |",
  "| --- | --- | --- |",
  "| 1 | 1 行目: 明細の表を AppGrid 化してほしい | R1, AC-01 |",
  "| 2 | 2 行目: いまは生の AgGridReact のまま（背景） | G |",
  "| 3 | 箇条 2: 読み取り専用・行頭列なし | R2 |",
  "| 4 | 箇条 3: 表ごとに変えてよいもの | R3 |",
  "| 5 | 箇条 4: 列構成・表示形式・色分けは変えない | R1, AC-02 |",
  "| 6 | 箇条 5: 文字選択の扱いは調べて判断を仰ぐ | R4 |",
  "| 7 | 箇条 6: BL-339 も片付ける | R5 |",
  "| 8 | 箇条 1: 上の表は既に AppGrid | O1 |",
  "",
  "### Added Requirements",
  "",
  "- R6: 依頼に無いが、既存のビルドとテストを壊さないことは全タスク共通の前提",
  ""
].join("\n");

const problemsOf = (text: string) => checkRequestMapping(text).problems;

// Test 248 — 契約の中身（純関数）: 実物は通り、故障注入の3ケースはそれぞれの理由で落ちる。テンプレートだけでは通らない。
test("248: request-mapping passes the real task and fails the three injected faults with their own reasons", () => {
  assert.deepEqual(problemsOf(REAL_TASK), [], "実物（新しい書式）は通る");
  assert.deepEqual(problemsOf("﻿" + REAL_TASK), [], "先頭の BOM は中身ではない（BL-285）");

  // (1) 写像漏れ: 依頼の行はあるが写像先が空
  const omitted = REAL_TASK.replace("| 4 | 箇条 3: 表ごとに変えてよいもの | R3 |", "| 4 | 箇条 3: 表ごとに変えてよいもの |  |");
  assert.match(problemsOf(omitted).join("\n"), /## Request Mapping row 4: empty mapping/);

  // (2) 架空 ID: 写像先が実在しない
  const phantom = REAL_TASK.replace("| 7 | 箇条 6: BL-339 も片付ける | R5 |", "| 7 | 箇条 6: BL-339 も片付ける | R9 |");
  const p2 = problemsOf(phantom).join("\n");
  assert.match(p2, /row 7: R9 is not defined/);
  assert.match(p2, /R5 is neither mapped from the request nor declared/, "指されなくなった R5 も見える");

  // (3) 依頼にない要件: どの行からも指されず、Added Requirements にも無い R
  const invented = REAL_TASK.replace("- R6: build・単体テスト・フル e2e を壊さない", "- R6: build・単体テスト・フル e2e を壊さない\n- R7: ついでに列の並び替えを足す");
  assert.match(problemsOf(invented).join("\n"), /R7 is neither mapped from the request nor declared under ### Added Requirements/);
  // 根拠つきで申告すれば通る（ゲート①で人間に見える）
  const declared = invented.replace("- R6: 依頼に無いが、", "- R7: 利用者の要望（口頭）で追加。依頼文には無い\n- R6: 依頼に無いが、");
  assert.deepEqual(problemsOf(declared), []);

  // 書式: ID の無い項目・重複・Added の欠落
  assert.match(problemsOf(REAL_TASK.replace("- R2: 読み取り専用", "- 読み取り専用")).join("\n"), /## Requirements: item without a valid ID/);
  assert.match(problemsOf(REAL_TASK.replace("- AC-02:", "- AC-01:")).join("\n"), /AC-01 appears twice/);
  assert.match(problemsOf(REAL_TASK.replace(/### Added Requirements[\s\S]*$/, "")).join("\n"), /### Added Requirements is missing/);

  // テンプレートそのものは通らない（書かずに素通りしない・BL-213 の教訓）
  const template = readFileSync(path.resolve(import.meta.dirname ?? ".", "..", "assets", "templates", "current-task.md"), "utf8");
  const t = problemsOf(template).join("\n");
  assert.match(t, /has no rows/);
  assert.match(t, /Added Requirements is empty/);
});

// Test 249 — 配線: task-planning の検証で halt し（executor に関係なく契約は同じ）、正しい表なら承認待ちへ進む。
// clipboard（assets の既定）でも同じ契約が効く＝ executor の 1 行を戻しても通る（不変条件5）。
test("249: task-planning halts on a broken mapping and reaches gate 1 with a complete one, on the clipboard config too", () => {
  for (const [label, text, expectHalt] of [
    ["正しい表", REAL_TASK, false],
    ["写像漏れ", REAL_TASK.replace("| R3 |", "|  |"), true],
    ["架空 ID", REAL_TASK.replace("| R5 |", "| R9 |"), true],
    ["依頼にない要件", REAL_TASK.replace("- R6: build", "- R7: 依頼に無い追加\n- R6: build"), true]
  ] as const) {
    const { root, config } = makeRoot();
    assert.equal(config.steps["task-planning"].executor, "clipboard", "テストの前提: assets の既定は clipboard");
    setStep(root, "task-planning");
    writeIn(root, "current-task.md", text);
    writeStatus(root, { step: "task-planning", result: "planned", reason: "x" });
    const out = runStep(root, config, "task-planning");
    if (expectHalt) {
      assert.equal(out.kind, "halted", `${label}: halt する`);
      assert.match((out as any).message ?? "", /request mapping/, `${label}: 理由は request-mapping`);
    } else {
      assert.equal(out.kind, "awaiting-approval", `${label}: 承認ゲート①へ進む`);
    }
  }
});

function withClaudePlanning(config: WorkflowConfig): WorkflowConfig {
  return { ...config, steps: { ...config.steps, "task-planning": { ...config.steps["task-planning"], executor: "claude" } } };
}

// Test 250 — new-task からの入口: claude の task-planning は Edit しか持たないので、消した current-status.json と
// 無い feature.md（stub: true）を 0 バイトで作る。clipboard のときは作らない。既存は上書きしない。記録は stub.created
test("250: new-task stubs the claude task-planning outputs (and feature.md via stub: true), never on clipboard", () => {
  {
    const { root, config } = makeRoot();
    const claude = withClaudePlanning(config);
    rmSync(path.join(root, "feature.md"), { force: true });
    writeIn(root, "current-status.json", JSON.stringify({ step: "reflection", result: "feature-complete", reason: "前タスク" }));
    resetForNewTask(root, claude);
    for (const f of ["current-status.json", "feature.md"]) {
      assert.ok(existsSync(path.join(root, f)), `${f} が無いと Edit は書けない`);
      assert.equal(statSync(path.join(root, f)).size, 0, `${f} は 0 バイト`);
    }
    assert.ok(statSync(path.join(root, "current-task.md")).size > 0, "テンプレートへ戻した current-task.md は上書きしない");
    const log = readEventLog(root);
    assert.ok(Array.isArray(log));
    const ev = (log as any[]).filter((r) => r.event === "stub.created").pop();
    assert.equal(ev.step, "task-planning");
    assert.equal(ev.via, "new-task");
    assert.deepEqual([...ev.files].sort(), ["current-status.json", "feature.md"]);
  }
  {
    const { root, config } = makeRoot(); // clipboard
    resetForNewTask(root, config);
    assert.equal(existsSync(path.join(root, "current-status.json")), false, "clipboard では作らない（「まだ誰も宣言していない」を保つ）");
    const log = readEventLog(root);
    assert.equal(Array.isArray(log) ? (log as any[]).filter((r) => r.event === "stub.created").length : 0, 0);
  }
  {
    // feature.md が既にあれば触らない
    const { root, config } = makeRoot();
    writeIn(root, "feature.md", "# Feature: X\n");
    resetForNewTask(root, withClaudePlanning(config));
    assert.equal(readFileSync(path.join(root, "feature.md"), "utf8"), "# Feature: X\n");
    assert.ok(rootPaths(root).eventLog);
  }
});
