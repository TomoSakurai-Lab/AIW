// request-mapping validator（小枠B・2026-10-19・設計 docs/design-task-planning.md §2）。
//
// task-planning の整形契約: 依頼（user-task.md）の各文・各要求が current-task.md のどこへ写ったかを、task-planning 自身が
// `## Request Mapping` の表で自己申告する。ここが縛るのは**表の完全性**だけ（measurement-completeness と同じ型）:
//   - 表があり、1 行以上ある / 各行の写像先が空でない / 写像先の ID が実在する / R・O・AC の ID が書式どおりで重複しない
//   - 依頼に由来しない要件は `### Added Requirements` に根拠つきで自己申告する（無ければ「なし」）。どの依頼行にも指されず、
//     そこにも無い R は「依頼にない要件」として落とす——整形が創作になる（executor 化の固有リスク）のを形式で見えるようにする
// 表の**内容の妥当性**（取りこぼし・写し間違い）は機械では判定しない。ゲート①で人間が表を見る。
//
// 写像先の `G` は Goal（背景の説明文を受ける）。⚠️ G へ写した文は**実装への拘束力を持たない**——「取りこぼしていない」の証明であって要求化ではない。

export const REQUEST_MAPPING_HEADING = "## Request Mapping";
export const ADDED_REQUIREMENTS_HEADING = "### Added Requirements";

const ID_PATTERNS: Record<string, RegExp> = {
  "## Requirements": /^R([1-9][0-9]*)$/,
  "## Out of Scope": /^O([1-9][0-9]*)$/,
  "## Acceptance Criteria": /^AC-([0-9]{2,})$/
};

/** `## X` 見出しの下の本文（次の `#` / `##` 見出しの手前まで。`###` は本文に含む） */
function sectionBody(lines: string[], heading: string): string[] | null {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    body.push(line);
  }
  return body;
}

/** `### X` 見出しの下の本文（次の見出しの手前まで） */
function subsectionBody(lines: string[], heading: string): string[] | null {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3} /.test(line)) break;
    body.push(line);
  }
  return body;
}

/** 箇条の先頭の ID（`- R1: …` / `- AC-01: …`）。字下げした子の箇条は対象外 */
function topLevelItems(body: string[]): string[] {
  return body.filter((l) => /^[-*] /.test(l)).map((l) => l.replace(/^[-*] /, "").trim());
}

export type RequestMappingCheck = { problems: string[]; rows: number; ids: Record<string, string[]> };

export function checkRequestMapping(raw: string): RequestMappingCheck {
  const text = raw.replace(/^﻿/, ""); // BL-285 と同じ（BOM は中身ではない）
  const lines = text.split(/\r?\n/);
  const problems: string[] = [];
  const ids: Record<string, string[]> = {};

  // 1. R / O / AC の ID（書式・重複）
  for (const [heading, pattern] of Object.entries(ID_PATTERNS)) {
    const body = sectionBody(lines, heading);
    if (body === null) {
      problems.push(`${heading} is missing`);
      ids[heading] = [];
      continue;
    }
    const seen: string[] = [];
    for (const item of topLevelItems(body)) {
      const m = item.match(/^([A-Za-z]+-?[0-9]+)\s*[:：]/);
      if (!m || !pattern.test(m[1])) {
        problems.push(`${heading}: item without a valid ID: "${item.slice(0, 40)}"`);
        continue;
      }
      if (seen.includes(m[1])) problems.push(`${heading}: ${m[1]} appears twice`);
      seen.push(m[1]);
    }
    ids[heading] = seen;
  }
  const defined = new Set([...Object.values(ids).flat(), "G"]);

  // 2. 対応表
  const mapping = sectionBody(lines, REQUEST_MAPPING_HEADING);
  let rows = 0;
  const referenced = new Set<string>();
  if (mapping === null) {
    problems.push(`${REQUEST_MAPPING_HEADING} is missing`);
  } else {
    const table = mapping.filter((l) => /^\s*\|/.test(l));
    const dataRows = table.slice(2); // 見出し行と区切り行を除く
    for (const [i, row] of dataRows.entries()) {
      const cells = row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      if (cells.every((c) => c === "")) continue;
      rows++;
      // 2026-10-20: 括弧の中は注記として読み飛ばす（実例: `G（phase 1 で完了）`）。以前は空白で区切って「phase」「1」を ID として落としていた
      const target = (cells[cells.length - 1] ?? "").replace(/（[^）]*）|\([^)]*\)/g, " ");
      const tokens = target.split(/[,、\s]+/).map((t) => t.replace(/`/g, "").trim()).filter(Boolean);
      if (tokens.length === 0) {
        problems.push(`${REQUEST_MAPPING_HEADING} row ${i + 1}: empty mapping`);
        continue;
      }
      for (const t of tokens) {
        if (!defined.has(t)) problems.push(`${REQUEST_MAPPING_HEADING} row ${i + 1}: ${t} is not defined`);
        referenced.add(t);
      }
    }
    if (rows === 0) problems.push(`${REQUEST_MAPPING_HEADING} has no rows`);
  }

  // 3. 依頼に由来しない要件の自己申告（必須。無ければ「なし」）
  const added = subsectionBody(lines, ADDED_REQUIREMENTS_HEADING);
  const declaredAdded = new Set<string>();
  if (added === null) {
    problems.push(`${ADDED_REQUIREMENTS_HEADING} is missing (write "- なし" when every requirement comes from the request)`);
  } else {
    const items = topLevelItems(added);
    if (items.length === 0) {
      problems.push(`${ADDED_REQUIREMENTS_HEADING} is empty (write "- なし" when every requirement comes from the request)`);
    }
    for (const item of items) {
      if (/^なし$|^none$/i.test(item)) continue;
      const m = item.match(/^(R[1-9][0-9]*)\s*[:：]\s*(.*)$/);
      if (!m) {
        problems.push(`${ADDED_REQUIREMENTS_HEADING}: "${item.slice(0, 40)}" is not "R<n>: <reason>"`);
        continue;
      }
      if (!defined.has(m[1])) problems.push(`${ADDED_REQUIREMENTS_HEADING}: ${m[1]} is not defined in ## Requirements`);
      if (m[2].trim() === "") problems.push(`${ADDED_REQUIREMENTS_HEADING}: ${m[1]} has no reason`);
      declaredAdded.add(m[1]);
    }
  }

  // 4. 依頼にない要件: どの依頼行からも指されず、追加要件としても申告されていない R
  if (mapping !== null && added !== null) {
    for (const r of ids["## Requirements"] ?? []) {
      if (!referenced.has(r) && !declaredAdded.has(r)) {
        problems.push(`${r} is neither mapped from the request nor declared under ${ADDED_REQUIREMENTS_HEADING}`);
      }
    }
  }

  return { problems, rows, ids };
}
