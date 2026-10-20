// aiw pr の説明文（docs/design-pr.md §A）。**純関数**: 入力 = source.ts の結果と画像の添付結果、出力 = 文字列。
//
// 客先レビュアー向けの日本語。内部用語（aiw / ステップ名 / validator 名 / BL-ID 等）は出さない（§A-3）。
// ⚠️ 自由記述（summary・手動確認・別途対応）は **ID の除去と定型語の置換だけ**で、言い換えはしない
// （機械が意味を変えないため）。客先向けの文に直すのは draft の段階の人間（公開ボタン = 署名）。
// 欠けた成果物は「記録なし」と書く。**0 件・確認済みへ丸めない。**
import { createHash } from "node:crypto";
import type { PrSource } from "./source.js";

/** Azure DevOps の説明文の上限（Update API の仕様: Description up to 4000 characters）。生成キーの行を含む */
export const DESCRIPTION_LIMIT = 4000;

const SEPARATOR = "\n\n---\n";
const OMITTED = "（以下省略。全文はタスクの記録を参照）";

export type PrImage = {
  /** 説明文での画面名（`after-` と拡張子を除いた名前） */
  label: string;
  /** 添付後の URL。null = 添付できなかった（縮退して保存先を書く） */
  url: string | null;
  /** 縮退したときに書く保存先（runtimeRoot の親からの相対） */
  displayPath: string;
};

export type Description = {
  title: string;
  description: string;
  generationKey: string;
  chars: number;
  /** 削った節（§A-4）。空なら削っていない */
  truncations: string[];
  /** ID 除去の後に自由記述に残った英字の語の数（v2 判定の材料・§A-3） */
  leftoverJargon: number;
  overLimit: boolean;
};

// ---- 内部用語（§A-3）。**定型語の置換表はここ 1 箇所。** -------------------------------------------

const ID_PATTERNS: RegExp[] = [
  /`?\b(?:BL|AC|OD|FAC|KI)-\d+[a-z]?\b`?/g,
  /`?\bTASK-\d{4}-\d{2}-\d{2}-[\w-]+`?/g,
  /`?\bFEAT-[\w-]+`?/g,
  /`?\b[ROG]\d{1,2}\b`?/g
];

const VOCABULARY: Array<[RegExp, string]> = [
  [/\bNOT[ _]VERIFIED\b/g, "未確認"],
  [/\bPASS\b/g, "確認済み"],
  [/\bFAIL\b/g, "不合格"],
  [/フル\s*e2e/gi, "画面の自動テスト一式"],
  [/\be2e\b/gi, "画面の自動テスト"]
];

/** ID を除き、定型語を置き換える。言い換えはしない。 */
export function scrub(text: string): string {
  let out = text;
  for (const re of ID_PATTERNS) out = out.replace(re, "");
  // 文頭・句点の後の ID を除くと助詞だけが残る（`R5 の「…」` → ` の「…」`、`。AC-01 は …` → `。 は …`）。空白を詰める前に落とす
  out = out.replace(/(^|[。、])\s*[のはがを](?:\s+|(?=「))/g, "$1");
  for (const [re, to] of VOCABULARY) out = out.replace(re, to);
  return out
    .replace(/[（(]\s*(?:[/／、,・+＋=＝]\s*)+/g, "（")
    .replace(/(?:\s*[/／、,・+＋=＝])+\s*[)）]/g, "）")
    .replace(/（\s+/g, "（")
    .replace(/\s+）/g, "）")
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    // 英字の語を和語へ置き換えると、和文の間に半角空白が残る（`フル e2e が` → `画面の自動テスト一式 が`）
    .replace(/([　-鿿＀-￯])[ \t]+(?=[　-鿿＀-￯])/g, "$1")
    .replace(/\s+([、。])/g, "$1")
    .replace(/、{2,}/g, "、")
    .trim();
}

/** 自由記述に残った英字の語（3 文字以上・重複なし）の数。 */
export function countLeftoverJargon(texts: string[]): number {
  const words = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) words.add(m[0].toLowerCase());
  }
  return words.size;
}

function firstSentence(s: string): string {
  const i = s.indexOf("。");
  return i >= 0 ? s.slice(0, i + 1) : s;
}

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---- 生成キー（§E-2）--------------------------------------------------------------------------

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function keyOf(body: string): string {
  return createHash("sha256").update(normalize(body), "utf8").digest("hex").slice(0, 12);
}

function footer(key: string): string {
  return `この説明文はタスクの記録から自動生成しました（生成キー: ${key}）。`;
}

/**
 * 既存の説明文が「aiw が書いたまま」か。生成キー行を除いた本文を計算し直し、生成キーと一致すれば true。
 * 生成キーが無い・一致しない = **人が直した**（上書きしない）。Azure DevOps が正規化して一致しなくなった場合も
 * false 側に倒れる（安全側）。
 */
export function isUntouchedByHuman(description: string): boolean {
  const text = description.replace(/\r\n/g, "\n");
  const at = text.lastIndexOf(SEPARATOR);
  if (at < 0) return false;
  const key = text.slice(at + SEPARATOR.length).match(/生成キー:\s*([0-9a-f]{12})/)?.[1];
  return key !== undefined && keyOf(text.slice(0, at)) === key;
}

// ---- 組み立て ---------------------------------------------------------------------------------

type Budget = { backlogChars: number | null; manualChars: number | null; fileCount: number; summaryChars: number | null; listCount: number | null };

const BUDGETS: Budget[] = [
  { backlogChars: null, manualChars: null, fileCount: 30, summaryChars: null, listCount: null },
  { backlogChars: 60, manualChars: null, fileCount: 30, summaryChars: null, listCount: null },
  { backlogChars: 60, manualChars: 80, fileCount: 30, summaryChars: null, listCount: null },
  { backlogChars: 60, manualChars: 80, fileCount: 15, summaryChars: null, listCount: null },
  { backlogChars: 60, manualChars: 80, fileCount: 15, summaryChars: 600, listCount: null },
  { backlogChars: 60, manualChars: 80, fileCount: 15, summaryChars: 600, listCount: 5 }
];

function list(items: string[], maxChars: number | null, maxCount: number | null, cuts: Set<string>, name: string): string[] {
  const shown = maxCount !== null && items.length > maxCount ? items.slice(0, maxCount) : items;
  const lines = shown.map((i) => {
    const s = maxChars !== null ? cut(i, maxChars) : i;
    if (s !== i) cuts.add(name);
    return `- ${s}`;
  });
  if (shown.length < items.length) {
    cuts.add(name);
    lines.push(`- ほか ${items.length - shown.length} 件`);
  }
  if (cuts.has(name)) lines.push(OMITTED);
  return lines;
}

function buildBody(src: PrSource, images: PrImage[], b: Budget, cuts: Set<string>): string {
  const out: string[] = [];

  // 概要
  out.push("## 概要");
  const summary = src.metadata?.summary ? scrub(src.metadata.summary) : null;
  if (summary === null) {
    out.push("タスクの要約の記録なし");
  } else if (b.summaryChars !== null && summary.length > b.summaryChars) {
    cuts.add("概要");
    out.push(cut(summary, b.summaryChars), OMITTED);
  } else {
    out.push(summary);
  }

  // 変更したファイル
  out.push("");
  if (src.declared === null) {
    out.push("## 変更したファイル", "変更ファイルの記録なし");
  } else {
    out.push(src.declared.source === "context-package" ? "## 変更したファイル" : "## 変更したファイル（実装報告による・事前宣言の記録なし）");
    const files = src.declared.files.map((f) => `\`${f}\``);
    if (files.length === 0) {
      out.push("（宣言なし）");
    } else {
      out.push(...list(files, null, b.fileCount, cuts, "変更したファイル"));
    }
  }
  out.push(`事前に宣言した変更範囲と実際の差分の突き合わせ: ${diffScopeLine(src)}`);

  // 確認結果
  out.push("", "## 確認結果");
  const ac = src.acceptance;
  if (ac === null) {
    out.push("受け入れ条件: 記録なし");
  } else {
    const total = ac.pass + ac.fail + ac.notVerified + ac.unrecognized;
    out.push(
      total === 0
        ? "受け入れ条件: 記録なし（集計できる行がない）"
        : `受け入れ条件: 確認済み ${ac.pass} / 不合格 ${ac.fail} / 未確認 ${ac.notVerified}${ac.unrecognized > 0 ? ` / 判定不明 ${ac.unrecognized}` : ""}（全 ${total} 件）`
    );
  }
  const mv = src.manualVerification;
  if (mv === null) {
    out.push("手動での確認が必要な項目: 記録なし");
  } else if (mv.length === 0) {
    out.push("手動での確認が必要な項目: なし");
  } else {
    out.push(`手動での確認が必要な項目（${mv.length} 件）:`);
    out.push(...list(mv.map((m) => scrub(firstSentence(m))), b.manualChars, b.listCount, cuts, "手動での確認"));
  }

  // レビュー
  out.push("", "## レビュー");
  const r = src.review;
  if (r.state === "absent") {
    out.push("レビュー記録なし");
  } else if (r.state === "template") {
    out.push("レビュー記録なし（記録が空のまま）");
  } else {
    out.push(`重大な指摘 ${r.critical} 件 / 主要な指摘 ${r.major} 件（レビュー時点）`);
    out.push(`- 修正: ${fixLine(src, r.critical + r.major)}`);
    if (r.backlog === null) {
      out.push("- 今回は対応せず別途対応とした事項: 記録なし");
    } else if (r.backlog.length > 0) {
      out.push(`- 今回は対応せず別途対応とした事項（${r.backlog.length} 件）:`);
      out.push(...list(r.backlog.map((s) => scrub(firstSentence(s))), b.backlogChars, b.listCount, cuts, "別途対応").map((l) => `  ${l}`));
    }
  }

  // 画面
  if (images.length > 0) {
    out.push("", "## 画面");
    const attached = images.filter((i) => i.url !== null);
    const degraded = images.filter((i) => i.url === null);
    for (const img of attached) out.push(`![${img.label}](${img.url})`);
    if (degraded.length > 0) {
      out.push("画面の記録はタスクの作業フォルダに保存しています:");
      for (const img of degraded) out.push(`- \`${img.displayPath}\``);
    }
  }
  return out.join("\n");
}

function diffScopeLine(src: PrSource): string {
  const p = src.process;
  if (p.state !== "present") return "検査の記録なし";
  const d = p.diffScope;
  if (d.failed > 0) return `検査済み・宣言外の変更あり（${d.failed} 回の検査で検出）`;
  if (d.passed > 0) return "検査済み・宣言外の変更なし";
  if (d.skipped > 0) return "検査は実行されていない";
  return "検査の記録なし";
}

function fixLine(src: PrSource, findings: number): string {
  const p = src.process;
  if (p.state !== "present") return "修正の記録なし";
  if (p.fixRuns === 0) return findings === 0 ? "修正なし（重大・主要な指摘なし）" : "修正の記録なし";
  return p.improveCheckPassed === true ? `修正を ${p.fixRuns} 回行い、修正後の確認を通過` : `修正を ${p.fixRuns} 回行った（修正後の確認の結果は記録なし）`;
}

export function buildTitle(src: PrSource): string {
  return src.metadata?.featureName ?? src.metadata?.taskName ?? src.taskId ?? "変更の提出";
}

/** 予算を段階的に締め、4000 字に収まった最初の版を返す。最後の段でも超えたら overLimit。 */
export function buildDescription(src: PrSource, images: PrImage[]): Description {
  let last: { body: string; cuts: Set<string> } | null = null;
  for (const b of BUDGETS) {
    const cuts = new Set<string>();
    const body = buildBody(src, images, b, cuts);
    last = { body, cuts };
    const key = keyOf(body);
    const description = `${normalize(body)}${SEPARATOR}${footer(key)}`;
    if (description.length <= DESCRIPTION_LIMIT) {
      return finish(src, description, key, cuts, false);
    }
  }
  const key = keyOf(last!.body);
  return finish(src, `${normalize(last!.body)}${SEPARATOR}${footer(key)}`, key, last!.cuts, true);
}

function finish(src: PrSource, description: string, key: string, cuts: Set<string>, overLimit: boolean): Description {
  const free = [
    src.metadata?.summary ? scrub(src.metadata.summary) : "",
    ...(src.manualVerification ?? []).map((m) => scrub(firstSentence(m))),
    ...(src.review.state === "present" ? (src.review.backlog ?? []).map((s) => scrub(firstSentence(s))) : [])
  ];
  return {
    title: buildTitle(src),
    description,
    generationKey: key,
    chars: description.length,
    truncations: [...cuts],
    leftoverJargon: countLeftoverJargon(free),
    overLimit
  };
}
