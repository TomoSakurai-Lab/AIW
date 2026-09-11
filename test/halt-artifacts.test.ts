// 止まる遷移は「成果物ファイルを書いて止まる」（M4 段階1-3 の着手条件）。
//
// research を executor 化すると、止まったときに人間へ残るのは**ファイルだけ**になる。
// 対話画面も、書きかけの状態も残らない。したがって次の3つが成立していないと、
// 「止まったが何も残っていない」＝人間が再開できない、が起きうる:
//
//   A. `ux-decision-required` … 承認ゲート②を通って research へ戻り、**成果物は1バイトも変わらない**
//      （人間が `# Open Decisions` に決定を書いて再実行する形が成立する）
//   B. 未宣言の result   … invalid-status で halt。**成果物は残り**、許容値が名指しされる
//   C. 成果物の欠落      … validation-failed で halt。**書けた分は残り**、欠けたものが名指しされる
//
// ⚠️ 実測（2026-09-11）で 3 件とも確認したうえで、**消えないようにここへ固定する**。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { approve, runStep } from "../src/engine/engine.js";
import {
  makeRoot,
  setStep,
  validCodexPrompt,
  validContextPackage,
  validResearchFindings,
  writeIn,
  writeStatus
} from "./helpers.js";

const OUTPUTS = ["context-package.md", "codex-prompt.md", "research-findings.md", "current-status.json"];

function arrangeResearch(result: string) {
  const { root, config } = makeRoot();
  setStep(root, "research");
  writeIn(root, "context-package.md", validContextPackage());
  writeIn(root, "codex-prompt.md", validCodexPrompt);
  writeIn(root, "research-findings.md", validResearchFindings);
  writeStatus(root, { step: "research", result, reason: "故障注入" });
  return { root, config };
}

/** 成果物の中身をまとめて取る（比較用）。不在は null で表す。 */
function snapshot(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of OUTPUTS) {
    try {
      out[f] = readFileSync(path.join(root, f), "utf8");
    } catch {
      out[f] = null;
    }
  }
  return out;
}

// Test 152 — A: `ux-decision-required` は成果物を残したまま research へ戻る。
test("152: a ux-decision-required halt keeps every artifact byte-identical and returns to research", () => {
  const { root, config } = arrangeResearch("ux-decision-required");
  const before = snapshot(root);

  // 承認ゲート②（timing: after）を通る。**自動で進まない**ことがまず要件
  const first = runStep(root, config, "research");
  assert.equal(first.kind, "awaiting-approval", "人間の承認を挟む（ゲート②）");

  const outcome = approve(root, config);
  assert.equal(outcome.kind, "transitioned");
  assert.equal((outcome as any).to, "research", "決定を書いて再実行するための自己遷移");

  assert.deepEqual(snapshot(root), before, "**成果物は1バイトも変わらない**（人間が読んで書き足す対象）");
  assert.match(readFileSync(path.join(root, "research-findings.md"), "utf8"), /# Open Decisions/);
});

// Test 153 — B: 宣言されていない result は halt。**成果物は残り、許容値が名指しされる。**
//
// executor が「clarification-required」のような未宣言の語を書いても、
// 黙って進まず、人間が直せる形で止まること。
test("153: an undeclared result halts as invalid-status, names the allowed values, and keeps the artifacts", () => {
  const { root, config } = arrangeResearch("clarification-required");
  const before = snapshot(root);

  const outcome = runStep(root, config, "research");

  assert.equal(outcome.kind, "halted");
  assert.equal((outcome as any).reason, "invalid-status");
  assert.match(String((outcome as any).message ?? ""), /clarification-required/);
  assert.deepEqual((outcome as any).detail?.allowed?.sort(), ["research-complete", "ux-decision-required"]);
  assert.deepEqual(snapshot(root), before, "止まっても成果物は消えない");
});

// Test 154 — C: 成果物が欠けたら halt。**書けた分は残り、欠けたものが名指しされる。**
test("154: a missing artifact halts naming the file, and whatever was written survives", () => {
  const { root, config } = arrangeResearch("ux-decision-required");
  rmSync(path.join(root, "codex-prompt.md"), { force: true });

  const outcome = runStep(root, config, "research");

  assert.equal(outcome.kind, "halted");
  assert.equal((outcome as any).reason, "validation-failed");
  assert.match(String((outcome as any).message ?? ""), /codex-prompt\.md/, "何が無いのかを名指しする");

  const after = snapshot(root);
  assert.equal(after["codex-prompt.md"], null);
  for (const f of OUTPUTS.filter((x) => x !== "codex-prompt.md")) {
    assert.ok(after[f], `${f} は書けているので残る`);
  }
});
