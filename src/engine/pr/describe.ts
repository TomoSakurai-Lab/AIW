// aiw pr の説明文（docs/design-pr.md §A）。**純関数**: 入力 = source.ts の結果と画像の添付結果、出力 = 文字列。
//
// 2026-10-23 改訂（§A-6・人間の判断）: 説明文は **「対応した内容」と「画面（変更前 → 変更後）」の 2 節だけ**。
// 「対応した内容」は依頼文（user-task.md）のチェックボックスの項目 = 客先の言葉。
// 概要・確認結果・レビュー・変更ファイルは客先向けには分かりにくかったので、`internalReport` として stdout にだけ出す。
// 内部用語（aiw / ステップ名 / validator 名 / BL-ID 等）は出さない（§A-3）。言い換えはしない（機械が意味を変えないため）。
// 欠けた成果物は「記録なし」と書く。**0 件・確認済みへ丸めない。**
import { createHash } from "node:crypto";
import type { PrSource } from "./source.js";

/** Azure DevOps の説明文の上限（Update API の仕様: Description up to 4000 characters）。生成キーの行を含む */
export const DESCRIPTION_LIMIT = 4000;

const SEPARATOR = "\n\n---\n";
const OMITTED = "（以下省略。全文はタスクの記録を参照）";

/** 1 枚の画像の置き場所。url が null = 添付できなかった（縮退して保存先を書く） */
export type ImageRef = { url: string | null; displayPath: string };

/** 説明文の 1 つの画面（名前で対にした変更前 / 変更後）。片方が無ければ null。label は labels.json の日本語のラベル */
export type ScreenPair = { name: string; before: ImageRef | null; after: ImageRef | null; label?: string | null };

function segments(s: string): string[] {
  return s
    .normalize("NFKC")
    .split("/")
    .map((x) => x.replace(/\s+/g, "").toLowerCase())
    .filter(Boolean);
}

/**
 * 画面を依頼の見出しへ割り当てる（2026-10-23・§A-6b）。ラベルが見出しと一致するか、ラベルの区切りが見出しの区切りの**末尾**と一致し、
 * その見出しが一意なとき（例: ラベル `取極（実績）タブ` ↔ 見出し `工種別予算管理表 / 取極（実績）タブ`）。全角・半角と空白は区別しない。
 * 当たらない画面（ラベル無し・どの見出しにも当たらない・候補が複数）は rest。
 */
export function placeScreens(headings: string[], screens: ScreenPair[]): { byHeading: Map<number, ScreenPair[]>; rest: ScreenPair[] } {
  const hs = headings.map(segments);
  const byHeading = new Map<number, ScreenPair[]>();
  const rest: ScreenPair[] = [];
  for (const s of screens) {
    let at = -1;
    if (s.label) {
      // まずラベルのまま照合し、当たらなければ末尾の補足（`…タブ（右側の列）`）を外して照合する。
      // 補足は同じタブの 2 枚目以降を区別するための書き方（implementation Skill v10）。見出し自体が（…）で終わる場合を先に拾うため、この順にする
      const stripped = s.label.replace(/\s*[（(][^（()）]*[)）]\s*$/, "");
      for (const candidate of stripped === s.label ? [s.label] : [s.label, stripped]) {
        const ls = segments(candidate);
        const exact = hs.findIndex((h) => h.join("/") === ls.join("/"));
        if (exact >= 0) {
          at = exact;
          break;
        }
        const tail = hs.map((h, i) => (ls.length > 0 && ls.length < h.length && h.slice(-ls.length).join("/") === ls.join("/") ? i : -1)).filter((i) => i >= 0);
        if (tail.length === 1) {
          at = tail[0];
          break;
        }
      }
    }
    if (at >= 0) byHeading.set(at, [...(byHeading.get(at) ?? []), s]);
    else rest.push(s);
  }
  return { byHeading, rest };
}

/** 同じ見出しに複数の対があるときの小見出し: 補足（`…タブ（右側の列）` の「右側の列」）。補足が無い（ラベル = 見出し）なら「全体」 */
function captionOf(s: ScreenPair, heading: string): string {
  const label = s.label ?? s.name;
  const norm = (x: string): string => x.normalize("NFKC").replace(/\s+/g, "");
  if (norm(label) === norm(heading)) return "全体";
  const caption = label.match(/[（(]([^（()）]*)[)）]\s*$/)?.[1];
  return caption && norm(label.replace(/\s*[（(][^（()）]*[)）]\s*$/, "")).endsWith(norm(heading).split("/").pop() ?? "") ? caption : label;
}

/** 変更前 → 変更後の画像の行（見出しは呼び出し側） */
function pairLines(s: ScreenPair): string[] {
  const label = s.label ?? s.name;
  return ["**変更前**", "", cell(s.before, `変更前 ${label}`), "", "**変更後**", "", cell(s.after, `変更後 ${label}`)];
}

/** ブランチの差分（§A-2b）。run.ts が git の読み取りで作る。null = 取れなかった */
export type BranchChanges = { files: string[] };

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
  /`?\b[ROG]\d{1,2}\b`?/g,
  // --import-feedback の取り込みの印（重複除けの内部の目印）。客先向けの文には出さない（2026-10-23 実例: 回のコメントに残っていた）
  /（PR コメント #\d+(?:-\d+)?）/g
];

const VOCABULARY: Array<[RegExp, string]> = [
  [/\bNOT[ _]VERIFIED\b/g, "未確認"],
  [/\bPASS\b/g, "確認済み"],
  [/\bFAIL\b/g, "不合格"],
  [/フル\s*e2e(?![\w.-])/gi, "画面の自動テスト一式"],
  // ファイル名の一部（`e2e-hierarchy-final.log`・`tests/e2e/`）は置き換えない（2026-10-23 実例）
  [/(?<![\w./-])e2e(?![\w./-])/gi, "画面の自動テスト"]
];

/** 和文（CJK 記号・かな・漢字・全角形）の間の半角空白。範囲はコードポイントで書く（生の全角空白をソースに置かない） */
const CJK = "[\\u{3000}-\\u{9FFF}\\u{FF00}-\\u{FFEF}]";
const CJK_GAP = new RegExp(`(${CJK})[ \\t]+(?=${CJK})`, "gu");

/** ID を除き、定型語を置き換える。言い換えはしない。 */
export function scrub(text: string): string {
  // 「ID と件数」は ID だけ除くと `×2` が浮く（2026-10-23 実例: `BL-344 ×2 と BL-236 ×1 に帰属`）
  let out = text.replace(/`?\bBL-\d+[a-z]?\b`?\s*[×xX]\s*(\d+)/g, "既知の課題（$1 件）");
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
    .replace(CJK_GAP, "$1")
    .replace(/\s+([、。])/g, "$1")
    .replace(/、{2,}/g, "、")
    .trim();
}

/**
 * 実データらしい語（契約番号・取引先コード・会社名）。**消さない**（消すと意味が変わる）。stdout に並べて公開前の人の判断に回す。
 * 2026-10-23 実例: 別途対応の本文に `19080010` / `K0221100 城南設備` / `東都電工` が出た（seed でも客先向けには出さないほうが安全）。
 */
export function sensitiveCandidates(description: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\b[A-Za-z]{1,3}\d{6,}\b/g, // 英字 + 6 桁以上（取引先・品目コード）
    /(?<![\w.-])\d{6,}(?![\w.-])/g, // 6 桁以上の数字（契約番号など。ファイル名・バージョンの一部は除く）
    // 語尾の後に漢字・カタカナが続くものは社名ではない（実例: `実行予算_建設クラウド` を誤検出した）。`_` も区切りとして扱う
    /[^\s`'"「」（）()、。・/_]{1,12}(?:株式会社|有限会社|㈱|（株）|建設|工業|電工|設備|商事|工務店|電機|興業)(?![\p{Script=Han}\p{Script=Katakana}])/gu,
    /(?:株式会社|有限会社|㈱|（株）)[^\s`'"「」（）()、。・/_]{1,12}/g
  ];
  for (const re of patterns) {
    for (const m of description.matchAll(re)) found.add(m[0]);
  }
  return [...found].slice(0, 20);
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

// ---- 組み立て（§A-6: 「対応した内容」と「画面」の 2 節）------------------------------------------

/** 4000 字に収めるための段（§A-4）。上から順に締める */
type Budget = { itemChars: number | null; subs: boolean; maxItems: number | null };

const BUDGETS: Budget[] = [
  { itemChars: null, subs: true, maxItems: null },
  { itemChars: 120, subs: true, maxItems: null },
  { itemChars: 120, subs: false, maxItems: null },
  { itemChars: 80, subs: false, maxItems: null },
  { itemChars: 60, subs: false, maxItems: 25 }
];

/**
 * 依頼の 1 項目の本文: **全文**を ID 除去と定型語の置換だけして使う。
 * 1 文目だけにすると意味が落ちる（実例: 「「予算キー」は不要。」だけでは何を変えたか分からない）。長ければ予算の段で切る
 */
function itemText(raw: string, b: Budget, cuts: Set<string>): string {
  const s = scrub(raw);
  if (b.itemChars !== null && s.length > b.itemChars) {
    cuts.add("対応した内容");
    return cut(s, b.itemChars);
  }
  return s;
}

function cell(ref: ImageRef | null, label: string): string {
  if (ref === null) return "（なし）";
  if (ref.url !== null) return `![${label}](${ref.url})`;
  return `保存先: \`${ref.displayPath}\``;
}

function buildBody(src: PrSource, screens: ScreenPair[], b: Budget, cuts: Set<string>): string {
  const out: string[] = ["## 対応した内容"];
  const groups = src.requested;
  if (groups === null) {
    out.push("依頼の記録なし");
  } else if (groups.length === 0) {
    // 依頼文にチェックボックスの項目が無い → 作業記録の要約で代える（見出しで区別する）
    out.splice(0, 1, "## 対応した内容（作業記録の要約）");
    out.push(src.metadata?.summary ? scrub(src.metadata.summary) : "要約の記録なし");
  }
  if (groups && groups.length > 0) {
    let shown = 0;
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    for (const g of groups) {
      if (b.maxItems !== null && shown >= b.maxItems) break;
      out.push("", `### ${g.heading}`);
      for (const item of g.items) {
        if (b.maxItems !== null && shown >= b.maxItems) break;
        out.push(`- ${itemText(item.text, b, cuts)}`);
        if (b.subs) for (const s of item.sub) out.push(`  ${scrub(s)}`);
        else if (item.sub.length > 0) cuts.add("対応した内容");
        shown++;
      }
    }
    if (shown < total) {
      cuts.add("対応した内容");
      out.push("", `ほか ${total - shown} 件`);
    }
    if (cuts.has("対応した内容")) out.push("", OMITTED);
  }
  // 画像は説明文に載せない（2026-10-23・§A-6c）。添付の URL は 1 枚約 200 字で、タブごとに撮ると 4000 字に収まらない（実例: 20 枚）。
  // 画像は PR のコメント（buildScreensComment）に、同じ見出しで並べる
  if (screens.length > 0) out.push("", SCREENS_POINTER);
  return out.join("\n");
}

/** 説明文から画像のコメントを指す 1 行 */
const SCREENS_POINTER = "変更前 → 変更後の画面は、この PR のコメント「画面（変更前 → 変更後）」に載せています。";
/** 画像のコメントの見出し。aiw が書いたコメントを探す目印も兼ねる（生成キーの行と両方で判定） */
export const SCREENS_HEADING = "## 画面（変更前 → 変更後）";

function screensFooter(key: string): string {
  return `この画面の比較はタスクの記録から自動生成しました（生成キー: ${key}）。`;
}

export type ScreensComment = { content: string; generationKey: string; chars: number };

/**
 * 画像のコメント（2026-10-23・§A-6c）。説明文と同じ見出し（タブごと）で変更前 → 変更後を全幅で並べる。
 * 同じ見出しに複数の対があれば小見出し（補足があれば補足だけ・無ければラベル）。見出しに当たらない画面は最後に「その他の画面」。
 * 画面が無ければ null（コメントを作らない）。末尾の生成キーは説明文と同じ仕組み（人が直したら上書きしない）
 */
export function buildScreensComment(src: PrSource, screens: ScreenPair[]): ScreensComment | null {
  if (screens.length === 0) return null;
  const groups = src.requested ?? [];
  const placed = placeScreens(groups.map((g) => g.heading), screens);
  const out: string[] = [SCREENS_HEADING];
  groups.forEach((g, gi) => {
    const mine = placed.byHeading.get(gi) ?? [];
    if (mine.length === 0) return;
    out.push("", `### ${g.heading}`);
    for (const s of mine) {
      out.push("");
      if (mine.length > 1) out.push(`#### ${captionOf(s, g.heading)}`, "");
      out.push(...pairLines(s));
    }
  });
  if (placed.rest.length > 0) {
    out.push("", groups.length > 0 ? "### その他の画面" : "### 画面");
    for (const s of placed.rest) out.push("", `#### ${s.label ?? s.name}`, "", ...pairLines(s));
  }
  const body = out.join("\n");
  const key = keyOf(body);
  const content = `${normalize(body)}${SEPARATOR}${screensFooter(key)}`;
  return { content, generationKey: key, chars: content.length };
}

// ---- 指摘への対応（第 n 回）のコメント（2026-10-23・§I 指摘の運用）-----------------------------------

const REPLY_HEADING = /^## 指摘への対応（第 (\d+) 回）/;

function replyFooter(taskId: string, key: string): string {
  return `この回の対応はタスクの記録から自動生成しました（対応の記録: ${taskId}・生成キー: ${key}）。`;
}

/**
 * 回のコメント: その回のタスクの依頼の項目（見出しごと）と、**その見出しの直下に**その回の変更前 → 変更後。
 * コメントには 4000 字の制限が無いので、説明文と違って画像を項目の直下に置ける（人間の注文「タブごとの比較」§A-6b）。
 * 見出しに当たらない画像は最後に「その他の画面」。依頼の項目が無ければ作業記録の要約で代える（説明文と同じ）
 */
export function buildReplyComment(src: PrSource, screens: ScreenPair[], round: number): ScreensComment {
  const out: string[] = [`## 指摘への対応（第 ${round} 回）`];
  const groups = src.requested ?? [];
  const placed = placeScreens(groups.map((g) => g.heading), screens);
  // 依頼の見出しが 1 つだけなら、当たらなかった画像もその見出しの下へ（その回の画像は全部その指摘のもの）。
  // 2026-10-23 実例: 取り込んだままの見出し「画面のコメントへの返信」とラベル「当該予算費消管理表 / メイン一覧」が照合できず、「その他の画面」に回った
  if (groups.length === 1 && placed.rest.length > 0) {
    placed.byHeading.set(0, [...(placed.byHeading.get(0) ?? []), ...placed.rest]);
    placed.rest = [];
  }
  const pairs = (list: ScreenPair[], heading: string): void => {
    for (const s of list) {
      out.push("");
      if (list.length > 1) out.push(`#### ${captionOf(s, heading)}`, "");
      out.push(...pairLines(s));
    }
  };
  if (src.requested === null) {
    out.push("", "依頼の記録なし");
  } else if (groups.length === 0) {
    out.push("", src.metadata?.summary ? scrub(src.metadata.summary) : "要約の記録なし");
  }
  groups.forEach((g, gi) => {
    out.push("", `### ${g.heading}`);
    for (const item of g.items) {
      out.push(`- ${scrub(item.text)}`);
      for (const s of item.sub) out.push(`  ${scrub(s)}`);
    }
    pairs(placed.byHeading.get(gi) ?? [], g.heading);
  });
  if (placed.rest.length > 0) {
    out.push("", groups.length > 0 ? "### その他の画面" : "### 画面");
    for (const s of placed.rest) out.push("", `#### ${s.label ?? s.name}`, "", ...pairLines(s));
  }
  const body = out.join("\n");
  const key = keyOf(body);
  const content = `${normalize(body)}${SEPARATOR}${replyFooter(src.taskId ?? "不明", key)}`;
  return { content, generationKey: key, chars: content.length };
}

/** aiw の回のコメントなら、その回の番号と対応の記録（Task ID）。違えば null */
export function parseReplyComment(content: string): { round: number; taskId: string } | null {
  const text = content.replace(/\r\n/g, "\n");
  const round = text.match(REPLY_HEADING)?.[1];
  const taskId = text.match(/この回の対応はタスクの記録から自動生成しました（対応の記録: ([^・）]+)・生成キー: [0-9a-f]{12}）/)?.[1];
  return round && taskId ? { round: Number(round), taskId } : null;
}

/** そのコメントが aiw の画像のコメントか（見出しと生成キーの行の両方がある） */
export function isScreensComment(content: string): boolean {
  const text = content.replace(/\r\n/g, "\n");
  return text.startsWith(SCREENS_HEADING) && /この画面の比較はタスクの記録から自動生成しました（生成キー: [0-9a-f]{12}）/.test(text);
}

/** 比較の画像が 1 対も当たらない依頼の見出し（--dry-run の警告用）。依頼の項目が無ければ空 */
export function headingsWithoutScreens(src: PrSource, screens: ScreenPair[]): string[] {
  const groups = src.requested ?? [];
  if (groups.length === 0) return [];
  const { byHeading } = placeScreens(groups.map((g) => g.heading), screens);
  return groups.filter((_, i) => !byHeading.has(i)).map((g) => g.heading);
}

/**
 * PR のタイトル（作成時のみ）。feature なら feature 名、無ければ依頼文の題（`## 次タスク：…`）。
 * 2026-10-27 実例: 単一タスクで taskName（`shuukei-minus-inyou`）がそのままタイトルになった
 */
export function buildTitle(src: PrSource): string {
  return src.metadata?.featureName ?? src.requestTitle ?? src.metadata?.taskName ?? src.taskId ?? "変更の提出";
}

/** 予算を段階的に締め、4000 字に収まった最初の版を返す。最後の段でも超えたら overLimit。 */
export function buildDescription(src: PrSource, screens: ScreenPair[]): Description {
  let last: { body: string; cuts: Set<string> } | null = null;
  for (const b of BUDGETS) {
    const cuts = new Set<string>();
    const body = buildBody(src, screens, b, cuts);
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
  const free =
    src.requested && src.requested.length > 0
      ? src.requested.flatMap((g) => g.items.map((i) => scrub(i.text)))
      : [src.metadata?.summary ? scrub(src.metadata.summary) : ""];
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

// ---- 内部の確認結果（stdout だけ・説明文には出さない）---------------------------------------------

/**
 * 以前は説明文に載せていた記録（概要・変更ファイル・突き合わせ・確認結果・レビュー）。客先向けには分かりにくいので
 * 説明文から外したが、**人間には見えたまま**にする（黙って捨てない）。生の記録をそのまま短く出す（scrub しない）。
 */
export function internalReport(src: PrSource, changes: BranchChanges | null): string[] {
  const out: string[] = [];
  const summary = src.metadata?.summary;
  out.push(`概要（task-metadata）: ${summary ? cut(summary, 200) : "記録なし"}`);
  out.push(`変更ファイル（ブランチの差分）: ${changes === null ? "取れない" : `${changes.files.length} 件`}`);
  out.push(`宣言との突き合わせ: ${diffScopeLine(src)}`);
  const ac = src.acceptance;
  const total = ac ? ac.pass + ac.fail + ac.notVerified + ac.unrecognized : 0;
  out.push(
    `受け入れ条件: ${ac === null ? "記録なし" : total === 0 ? "記録なし（集計できる行がない）" : `PASS ${ac.pass} / FAIL ${ac.fail} / NOT VERIFIED ${ac.notVerified}${ac.unrecognized > 0 ? ` / 判定不明 ${ac.unrecognized}` : ""}（全 ${total}）`}`
  );
  const mv = src.manualVerification;
  out.push(`手動確認: ${mv === null ? "記録なし" : mv.length === 0 ? "なし" : `${mv.length} 件`}`);
  for (const m of mv ?? []) out.push(`  - ${cut(m, 120)}`);
  const r = src.review;
  if (r.state !== "present") {
    out.push(`レビュー: ${r.state === "absent" ? "記録なし" : "記録なし（テンプレートのまま）"}`);
  } else {
    out.push(`レビュー: Critical ${r.critical} / Major ${r.major}・修正: ${fixLine(src, r.critical + r.major)}`);
    out.push(`別途対応（Backlog）: ${r.backlog === null ? "記録なし" : `${r.backlog.length} 件`}`);
    for (const s of r.backlog ?? []) out.push(`  - ${cut(s, 120)}`);
  }
  return out;
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

