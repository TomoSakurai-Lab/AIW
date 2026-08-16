// diff-scope の宣言源パース。設計 docs/design-diff-scope.md 課題5。
//
// | step           | 宣言源             | セクション            |
// | implementation | context-package.md | `## Modify`           |
// | fix            | current-review.md  | `### Files To Modify` |
//
// どちらのセクションも artifact-contract（halt）が存在を保証済みなので、見出しが無いのは
// 「検査できなかった」ではなく契約違反 → failed（skipped にしない）。
import { extractSection, stripHtmlComments } from "./sections.js";

export type DeclaredFiles =
  | { ok: true; files: string[]; dirPrefixes: string[] }
  | { ok: false; reason: "section-missing"; section: string };

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const INLINE_CODE = /`([^`]+)`/;

// 実物の書式: - `path/to/file.ts`（`:49-50`）
// list item の **最初のインラインコード内**をパスに採る。括弧・行番号などの付記は無視。
// インラインコードが無い行は行頭トークン（最初の空白まで）。
export function parseDeclaredLine(line: string): string | null {
  const item = line.match(LIST_ITEM);
  if (!item) {
    return null;
  }
  const body = item[1].trim();
  if (body === "") {
    return null;
  }
  const code = body.match(INLINE_CODE);
  const raw = code ? code[1] : body.split(/\s+/)[0];
  return normalizePath(raw);
}

function normalizePath(raw: string): string | null {
  const p = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^["'<(\[]+/, "")
    .replace(/["'>)\]]+$/, "");
  return p === "" || p === "." ? null : p;
}

export function parseDeclaredFiles(markdown: string, section: string): DeclaredFiles {
  const body = extractSection(markdown, section);
  if (body === null) {
    return { ok: false, reason: "section-missing", section };
  }

  const files: string[] = [];
  const dirPrefixes: string[] = [];
  for (const line of stripHtmlComments(body).split(/\r?\n/)) {
    const p = parseDeclaredLine(line);
    if (p === null) {
      continue;
    }
    if (p.endsWith("/")) {
      dirPrefixes.push(p);
    } else {
      files.push(p);
    }
  }

  // 見出しはあるが項目ゼロ → 空配列を返す。**`ok: false` にしない。**
  // 呼び出し側に「宣言が無いなら検査をスキップ」と書かせないため、欠落(ok:false)と
  // 宣言ゼロ(空配列)を型で区別する。宣言ゼロは「全変更ファイルが違反候補」であり、
  // 「何も変更しないはずの fix でファイルが変わった」を検出する正しい挙動（設計・罠5）。
  return { ok: true, files, dirPrefixes };
}

export function isDeclared(target: string, declared: DeclaredFiles, ignoreCase: boolean): boolean {
  if (!declared.ok) {
    return false;
  }
  const norm = (p: string): string => (ignoreCase ? p.toLowerCase() : p);
  const t = norm(target.replace(/\\/g, "/"));
  if (declared.files.some((f) => norm(f) === t)) {
    return true;
  }
  return declared.dirPrefixes.some((d) => t.startsWith(norm(d)));
}
