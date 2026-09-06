// 承認ゲートの判断材料（2026-09-06）。
//
// **表示だけ。** 判定・遷移・exit code には一切触らない（不変条件1）。
// エンジンは事実を集めて返し、整形と表示は CLI が行う——既存の分離をそのまま踏襲する。
//
// ## なぜ要るか
//
// clipboard 運用では、成果物を作った対話AIが同じ画面で要点を要約してくれていた。
// executor 化するとファイルだけが残り、承認ゲートは y/n を聞くだけになる。
// **人間が何を見て承認するのかが宙に浮く**ので、ゲートの直前に事実を並べる。
//
// ## 何を並べるか（順序に意味がある）
//
//   1. 判定と理由      — current-status.json の result / reason（AI 自身の言い分）
//   2. 成果物の鮮度    — 依頼（user-task.md）より古い成果物を名指しする
//   3. 契約セクション  — artifacts の宣言どおりの見出しと、その配下の項目数
//
// **2 を 1 より下に置かない。** 実測（2026-09-06）: 前タスクの `current-task.md` が
// 残ったまま承認待ちになり、`file-exists` も `artifact-contract` も通り、
// reject → `aiw run` の再実行でも同じ古いファイルが再検証された。
// 中身の良し悪しを読む前に「そもそも今回の依頼のものか」を見る必要がある。
//
// ## 三値の規律
//
// 件数は `number | null`。**null は「そのセクションが無い」であって 0 件ではない。**
// 鮮度も同じで、依頼ファイルが無ければ `null`（判定不能）。0 や false へ潰さない。
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { countListItems, extractSection } from "./sections.js";
import { readStatus } from "./status.js";
import type { ArtifactDef, WorkflowConfig } from "./types.js";

/**
 * 依頼の正本。`aiw new-task` がこの名前を空に戻すので、CLI 側と同じ固定名を使う。
 * ⚠️ 名前を増やすと「片方だけ直して片方が古い名前を見る」形になる（RUNTIME_DIR_NAME と同じ理由）。
 */
export const REQUEST_FILE = "user-task.md";

export type Freshness = {
  /** root 相対 */
  file: string;
  exists: boolean;
  mtimeMs: number | null;
  /** 依頼より古いか。**null は判定不能**（依頼ファイルか成果物が無い） */
  olderThanRequest: boolean | null;
};

export type SectionCount = {
  /** 契約が宣言している見出し（例 "## Scope"） */
  section: string;
  /** 配下の箇条書き件数。**null は見出しが無い**（0 件ではない） */
  items: number | null;
  /**
   * 下位見出しを含む「入れ物」の見出しか。
   *
   * ⚠️ 入れ物の件数は子の合計になるので数字として意味が無い（実測: `# Task` が 35 と出た）。
   * 0 でも null でもない第三の状態なので、**件数へ潰さずフラグで持つ**。
   */
  container: boolean;
};

export type Outline = {
  file: string;
  sections: SectionCount[];
};

export type ApprovalBriefing = {
  step: string;
  /** current-status.json の宣言。無ければ null */
  declared: { result: string; reason: string } | null;
  /** 依頼ファイルの更新時刻。null なら user-task.md が無い */
  requestMtimeMs: number | null;
  /** そのステップの必須成果物の鮮度 */
  freshness: Freshness[];
  /** markdown-sections 契約を持つ成果物の見出し別件数 */
  outlines: Outline[];
};

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** artifacts 定義から、その path を持つ契約を引く。**見出し一覧を手書きしないため。** */
function contractFor(config: WorkflowConfig, relPath: string): ArtifactDef | null {
  for (const def of Object.values(config.artifacts ?? {})) {
    if (def.path === relPath) {
      return def;
    }
  }
  return null;
}

export function buildBriefing(root: string, config: WorkflowConfig, stepId: string): ApprovalBriefing {
  const abs = path.resolve(root);
  const step = config.steps[stepId];
  const requestMtimeMs = mtimeOf(path.join(abs, REQUEST_FILE));

  let declared: ApprovalBriefing["declared"] = null;
  try {
    const status = readStatus(root, String(config.settings.statusFile ?? "current-status.json"));
    if (status && typeof status.result === "string") {
      declared = { result: status.result, reason: String(status.reason ?? "") };
    }
  } catch {
    // 壊れた JSON は json-schema validator の担当。ここで判定はしない（表示だけの責務）
    declared = null;
  }

  const freshness: Freshness[] = [];
  const outlines: Outline[] = [];
  for (const output of step?.outputs ?? []) {
    const file = path.join(abs, output.path);
    const mtimeMs = mtimeOf(file);
    freshness.push({
      file: output.path,
      exists: mtimeMs !== null,
      mtimeMs,
      olderThanRequest: mtimeMs === null || requestMtimeMs === null ? null : mtimeMs < requestMtimeMs
    });

    const def = contractFor(config, output.path);
    if (!def || def.contract.type !== "markdown-sections" || mtimeMs === null) {
      continue;
    }
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    outlines.push({
      file: output.path,
      // ⚠️ 見出しは**契約の宣言そのもの**。ここで別の一覧を持たない（契約の二重管理を作らない）。
      // `### ` は畳んで表示側で捨てる（review の 19 見出しをそのまま並べると読めない）。
      sections: def.contract.sections
        .filter((s) => !s.startsWith("### "))
        .map((section) => {
          const sectionBody = extractSection(body, section);
          return {
            section,
            items: sectionBody === null ? null : countListItems(sectionBody),
            container: sectionBody !== null && /^#{1,6}\s/m.test(sectionBody)
          };
        })
    });
  }

  return { step: stepId, declared, requestMtimeMs, freshness, outlines };
}

function stamp(mtimeMs: number | null): string {
  if (mtimeMs === null) {
    return "（未作成）";
  }
  const d = new Date(mtimeMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatBriefing(b: ApprovalBriefing): string {
  const lines: string[] = [`承認ゲート "${b.step}" の判断材料`, ""];

  if (b.declared) {
    lines.push(`宣言 (current-status.json)`);
    lines.push(`  result: ${b.declared.result}`);
    lines.push(`  reason: ${b.declared.reason || "（空）"}`);
  } else {
    lines.push(`宣言 (current-status.json)  — 読めない / 未作成`);
  }
  lines.push("");

  lines.push(`成果物の鮮度  （依頼 ${REQUEST_FILE}: ${stamp(b.requestMtimeMs)}）`);
  for (const f of b.freshness) {
    const flag =
      f.olderThanRequest === null
        ? "  ? 依頼と比較できない"
        : f.olderThanRequest
          ? "  ⚠ 依頼より古い（前タスクの残骸かもしれない）"
          : "";
    lines.push(`  ${f.file}  ${stamp(f.mtimeMs)}${flag}`);
  }
  if (b.freshness.some((f) => f.olderThanRequest === true)) {
    // ⚠️ **これは validator が見ていない。** file-exists はファイルが在れば通り、
    // artifact-contract は見出しが在れば通る。古い成果物は両方を素通りする。
    lines.push("  ※ 内容を読む前に、その成果物が今回の依頼のものか確かめること。");
  }

  for (const outline of b.outlines) {
    lines.push("");
    lines.push(`${outline.file} の中身（契約の見出し / 箇条書き件数）`);
    for (const s of outline.sections) {
      const value = s.items === null ? "-" : s.container ? "…" : String(s.items);
      lines.push(`  ${s.section.padEnd(34)} ${value}`);
    }
    if (outline.sections.some((s) => s.items === null)) {
      lines.push('  ※ "-" は見出しが無い（0 件ではない）。');
    }
    if (outline.sections.some((s) => s.container)) {
      lines.push('  ※ "…" は下位見出しを含む入れ物（件数は子の合計になるので出さない）。');
    }
  }
  return lines.join("\n");
}
