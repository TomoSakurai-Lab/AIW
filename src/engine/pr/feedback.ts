// PR の指摘を、指摘への対応のタスクの依頼文（user-task.md）の下書きにする（aiw pr --import-feedback・設計 §I-2）。**純関数**。
//
// 読むのは未解決（active / pending）のスレッドだけ。system のコメントと aiw 自身のコメント（画面のコメント・回のコメント）は除く。
// 指摘 1 スレッド = チェックボックス 1 つ。末尾の「（PR コメント #<スレッド ID>）」で、打ち直しても同じ指摘を二重に入れない。
// 投稿者の名前は書かない（依頼の中身に要らない・runtime に個人名を増やさない）。
// ⚠️ これは**下書き**。見出しを画面 / タブに整理し、指摘を依頼の言葉に直すのは人間（task-planning の承認ゲート①の前）。
import type { AzdoThreadDetail } from "./azdo.js";
import { isScreensComment, parseReplyComment } from "./describe.js";

/** 取り込む対象のスレッドの状態（未解決） */
const OPEN_STATUSES = new Set(["active", "pending"]);
/** 依頼文に残す取り込みの印。打ち直しの重複除けにも使う */
const MARK = (threadId: number): string => `（PR コメント #${threadId}）`;
const MARK_RE = /（PR コメント #(\d+)）/g;

export type FeedbackDraft = {
  /** 書き込む全文（user-task.md の新しい内容） */
  text: string;
  /** 今回取り込んだスレッド ID */
  imported: number[];
  /** 既に依頼文にあったので取り込まなかったスレッド ID */
  alreadyPresent: number[];
  /** 対象外として除いた数（解決済み・system・aiw のコメント） */
  excluded: number;
  /** 雛形（空）へ書いたか、既存の依頼文の末尾へ足したか */
  mode: "new" | "append";
};

/** 未解決の、人のコメントのスレッドか（aiw のコメントと system は除く） */
export function isOpenFeedback(t: AzdoThreadDetail): boolean {
  if (!t.status || !OPEN_STATUSES.has(t.status.toLowerCase())) return false;
  const first = t.comments.find((c) => c.parentCommentId === 0) ?? t.comments[0];
  if (!first || first.commentType.toLowerCase() === "system") return false;
  if (isScreensComment(first.content) || parseReplyComment(first.content) !== null) return false;
  return first.content.trim() !== "";
}

/** コメントの本文を 1 行目と残りの行に分ける（空行は捨てる。Markdown の画像やリンクはそのまま残す） */
function lines(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => l.replace(/^(?:[-*+]|\d+[.)])\s+/, "")); // 客先の箇条書きの印は子の行の印と重ならないよう外す
}

function threadItem(t: AzdoThreadDetail): string[] {
  const first = t.comments.find((c) => c.parentCommentId === 0) ?? t.comments[0];
  const [head, ...rest] = lines(first.content);
  const where = t.filePath && t.line !== null ? `（${t.line} 行目）` : "";
  const out = [`- [ ] ${head}${where}${MARK(t.id)}`];
  for (const l of rest) out.push(`  - ${l}`);
  for (const reply of t.comments.filter((c) => c !== first && c.commentType.toLowerCase() !== "system")) {
    const [rh, ...rr] = lines(reply.content);
    if (!rh) continue;
    out.push(`  - 返信: ${rh}`);
    for (const l of rr) out.push(`    - ${l}`);
  }
  return out;
}

/** 雛形のまま（見出しと HTML コメントしか無い）か */
export function isTemplateLike(text: string): boolean {
  return (
    text
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^#\s+User Task\s*$/m, "")
      .trim() === ""
  );
}

/**
 * 下書きを組み立てる。今の user-task.md が雛形のまま（空）なら全体を書き、人が書きかけていれば末尾に節を足す。
 * 既に印（PR コメント #ID）のある指摘は取り込まない。取り込む指摘が 0 件なら text は今のまま（書き込まない判断は呼び出し側）
 */
export function buildFeedbackDraft(threads: AzdoThreadDetail[], current: string, today: string, prUrl: string): FeedbackDraft {
  const present = new Set([...current.matchAll(MARK_RE)].map((m) => Number(m[1])));
  const open = threads.filter(isOpenFeedback);
  const alreadyPresent = open.filter((t) => present.has(t.id)).map((t) => t.id);
  const fresh = open.filter((t) => !present.has(t.id));
  const excluded = threads.length - open.length;
  const mode: FeedbackDraft["mode"] = isTemplateLike(current) ? "new" : "append";
  if (fresh.length === 0) {
    return { text: current, imported: [], alreadyPresent, excluded, mode };
  }

  // PR 全体へのコメントを先に、ファイルの行に付いたものはファイルごとにまとめる
  const general = fresh.filter((t) => !t.filePath);
  const byFile = new Map<string, AzdoThreadDetail[]>();
  for (const t of fresh.filter((t) => t.filePath)) byFile.set(t.filePath!, [...(byFile.get(t.filePath!) ?? []), t]);
  const body: string[] = [];
  if (general.length > 0) {
    body.push("### PR 全体への指摘", "");
    for (const t of general) body.push(...threadItem(t));
  }
  for (const [file, list] of byFile) {
    if (body.length > 0) body.push("");
    body.push(`### ${file.replace(/^\//, "")}`, "");
    for (const t of list) body.push(...threadItem(t));
  }

  const note = [
    `<!-- aiw pr --import-feedback が ${today} に PR（${prUrl}）の未解決のコメント ${fresh.length} 件から作った下書き。`,
    "     見出しを画面 / タブ（例: ### 工種別予算管理表 / 取極（実績）タブ）に整理し、指摘を依頼の言葉に直してから task-planning へ。",
    "     「（PR コメント #番号）」は取り込みの印（打ち直しても二重に入らない）。消してもよいが、消すと次の取り込みでもう一度入る -->"
  ];
  const section = [`## PR の指摘への対応（${today} 取り込み）`, "", ...note, "", ...body];
  const text =
    mode === "new"
      ? ["# User Task", "", ...section, ""].join("\n")
      : `${current.replace(/\s+$/, "")}\n\n${section.join("\n")}\n`;
  return { text, imported: fresh.map((t) => t.id), alreadyPresent, excluded, mode };
}
