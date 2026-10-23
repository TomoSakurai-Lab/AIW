// PR の指摘を、指摘への対応のタスクの依頼文（user-task.md）の下書きにする（aiw pr --import-feedback・設計 §I-2）。**純関数**。
//
// 読むのは未解決（active / pending）のスレッドだけ。system のコメントは除く。
//   - 人が始めたスレッド: 指摘 1 スレッド = チェックボックス 1 つ（返信は子の行）。印は「（PR コメント #<スレッド>）」
//   - aiw のコメント（画面のコメント・指摘への対応の回のコメント）のスレッド: aiw の本文は取り込まず、**そこへの返信 1 件 = チェックボックス 1 つ**。
//     印は「（PR コメント #<スレッド>-<コメント>）」。2026-10-23 実例: 画像を見ながら画面のコメントへ返信で指摘され、スレッドごと除いていたので取り込めなかった
// 印で、打ち直しても同じ指摘を二重に入れない。投稿者の名前は書かない（依頼の中身に要らない・runtime に個人名を増やさない）。
// ⚠️ これは**下書き**。見出しを画面 / タブに整理し、指摘を依頼の言葉に直すのは人間（task-planning の承認ゲート①の前）。
import type { AzdoThreadDetail } from "./azdo.js";
import { isScreensComment, parseReplyComment } from "./describe.js";

/** 取り込む対象のスレッドの状態（未解決） */
const OPEN_STATUSES = new Set(["active", "pending"]);
/** 依頼文に残す取り込みの印。打ち直しの重複除けにも使う。キーは「スレッド」か「スレッド-コメント」 */
const MARK = (key: string): string => `（PR コメント #${key}）`;
const MARK_RE = /（PR コメント #(\d+(?:-\d+)?)）/g;

export type FeedbackDraft = {
  /** 書き込む全文（user-task.md の新しい内容） */
  text: string;
  /** 今回取り込んだ指摘のキー（「スレッド」または「スレッド-コメント」） */
  imported: string[];
  /** 既に依頼文にあったので取り込まなかった指摘のキー */
  alreadyPresent: string[];
  /** 指摘を 1 件も含まないので除いたスレッドの数（解決済み・system・返信の無い aiw のコメント） */
  excluded: number;
  /** 雛形（空）へ書いたか、既存の依頼文の末尾へ足したか */
  mode: "new" | "append";
};

/** 取り込む単位: 指摘 1 件 */
type Unit = { key: string; heading: string; lines: string[] };

/** コメントの本文を行に分ける（空行は捨てる。Markdown の画像やリンクはそのまま残す） */
function lines(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => l.replace(/^(?:[-*+]|\d+[.)])\s+/, "")); // 客先の箇条書きの印は子の行の印と重ならないよう外す
}

const isSystem = (c: { commentType: string }): boolean => c.commentType.toLowerCase() === "system";
const isAiw = (content: string): boolean => isScreensComment(content) || parseReplyComment(content) !== null;

/** 1 つのスレッドから取り込む指摘（0 件以上） */
function unitsOf(t: AzdoThreadDetail): Unit[] {
  if (!t.status || !OPEN_STATUSES.has(t.status.toLowerCase())) return [];
  const first = t.comments.find((c) => c.parentCommentId === 0) ?? t.comments[0];
  if (!first || isSystem(first)) return [];

  if (isAiw(first.content)) {
    // aiw のコメントへの返信を 1 件ずつ。見出しは、どの aiw のコメントへの返信か
    const round = parseReplyComment(first.content)?.round;
    const heading = round !== undefined ? `指摘への対応（第 ${round} 回）への返信` : "画面のコメントへの返信";
    return t.comments
      .filter((c) => c !== first && !isSystem(c) && !isAiw(c.content))
      .map((c) => {
        const [head, ...rest] = lines(c.content);
        return head ? { key: `${t.id}-${c.id}`, heading, lines: [`- [ ] ${head}${MARK(`${t.id}-${c.id}`)}`, ...rest.map((l) => `  - ${l}`)] } : null;
      })
      .filter((u): u is Unit => u !== null);
  }

  const [head, ...rest] = lines(first.content);
  if (!head) return [];
  const where = t.filePath && t.line !== null ? `（${t.line} 行目）` : "";
  const out = [`- [ ] ${head}${where}${MARK(String(t.id))}`, ...rest.map((l) => `  - ${l}`)];
  for (const reply of t.comments.filter((c) => c !== first && !isSystem(c))) {
    const [rh, ...rr] = lines(reply.content);
    if (!rh) continue;
    out.push(`  - 返信: ${rh}`);
    for (const l of rr) out.push(`    - ${l}`);
  }
  return [{ key: String(t.id), heading: t.filePath ? t.filePath.replace(/^\//, "") : "PR 全体への指摘", lines: out }];
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
 * 既に印のある指摘は取り込まない。取り込む指摘が 0 件なら text は今のまま（書き込まない判断は呼び出し側）
 */
export function buildFeedbackDraft(threads: AzdoThreadDetail[], current: string, today: string, prUrl: string): FeedbackDraft {
  const present = new Set([...current.matchAll(MARK_RE)].map((m) => m[1]));
  const perThread = threads.map(unitsOf);
  const units = perThread.flat();
  const alreadyPresent = units.filter((u) => present.has(u.key)).map((u) => u.key);
  const fresh = units.filter((u) => !present.has(u.key));
  const excluded = perThread.filter((u) => u.length === 0).length;
  const mode: FeedbackDraft["mode"] = isTemplateLike(current) ? "new" : "append";
  if (fresh.length === 0) {
    return { text: current, imported: [], alreadyPresent, excluded, mode };
  }

  // 見出しごとにまとめる（PR 全体 → aiw のコメントへの返信 → ファイルの行、の順。同じ種類の中は出てきた順）
  const order = (h: string): number => (h === "PR 全体への指摘" ? 0 : h.endsWith("への返信") ? 1 : 2);
  const headings = [...new Set(fresh.map((u) => u.heading))].sort((a, b) => order(a) - order(b));
  const body: string[] = [];
  for (const h of headings) {
    if (body.length > 0) body.push("");
    body.push(`### ${h}`, "");
    for (const u of fresh.filter((x) => x.heading === h)) body.push(...u.lines);
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
  return { text, imported: fresh.map((u) => u.key), alreadyPresent, excluded, mode };
}
