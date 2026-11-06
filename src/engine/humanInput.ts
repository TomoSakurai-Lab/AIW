// BL-392（2026-11-06）: 人が書く入力（inputs の `humanInput: true`）がまだ書かれていないかを見る。
//
// 実測（10-23 12:13 / 10-26 03:00）: drive の「新しいタスクを始めますか？」に y と答えた直後（`aiw new-task` が
// user-task.md をテンプレートへ戻した直後）に task-planning を claude で起動し、claude は「user-task.md が空なので実行できません」と
// 返して何も書かずに終わった（current-status.json の空で halt が 4 件）。task-planning を auto の区間へ入れると、この経路が人の確認なしで毎回起きる。
//
// 判定は「`templates/` の同名ファイルと同じ」だけ（人間の裁定・論点2）。エンジンは Markdown を解釈しない——
// 見出しやコメントの意味を知らずに済み、テンプレートを変えても判定が追従する。比べる前に BOM・改行コード・行末の空白・末尾の空行を揃える
// （エディタで開いて保存しただけの差を「書いた」と数えない）。ファイルが無いのも「誰も書いていない」。
//
// ⚠️ engine.ts を import しない（engine.ts がここを import する。循環させない）。拒否の例外 UnfilledInputError は engine.ts 側に置く。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { rootPaths } from "./paths.js";
import type { WorkflowStep } from "./types.js";

export type UnfilledInput = {
  path: string;
  /** missing = ファイルが無い / template = テンプレートのまま */
  reason: "missing" | "template";
};

function normalize(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * まだ書かれていない人の入力を返す（無ければ空配列）。
 * ⚠️ `humanInput: true` を宣言したのにテンプレートが無ければ例外——比べる相手が無いまま「書かれている」と黙って通さない（不変条件7 と同じ型）。
 */
export function unfilledHumanInputs(root: string, step: WorkflowStep): UnfilledInput[] {
  const { templatesDir } = rootPaths(root);
  const found: UnfilledInput[] = [];
  for (const ref of step.inputs ?? []) {
    if (ref.humanInput !== true) continue;
    const template = path.join(templatesDir, ref.path);
    if (!existsSync(template)) {
      throw new Error(
        `step "${step.id}": input "${ref.path}" is declared humanInput but templates/${ref.path} does not exist (nothing to compare against).`
      );
    }
    const file = path.join(root, ref.path);
    if (!existsSync(file)) {
      found.push({ path: ref.path, reason: "missing" });
      continue;
    }
    if (normalize(readFileSync(file, "utf8")) === normalize(readFileSync(template, "utf8"))) {
      found.push({ path: ref.path, reason: "template" });
    }
  }
  return found;
}

/** 表示用: 「user-task.md（テンプレートのまま）」 */
export function describeUnfilled(list: UnfilledInput[]): string {
  return list.map((u) => `${u.path}（${u.reason === "missing" ? "ファイルが無い" : "テンプレートのまま"}）`).join("、");
}
