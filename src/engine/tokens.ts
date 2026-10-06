// Deterministic token estimate for the token-range validator (MVP: heuristic, not a model
// tokenizer). Approximates ~4 chars/token with a word-count floor, which is stable and good
// enough to catch grossly under/over-sized context packages. The actual bounds live in
// workflow.yaml's token-range validator — do not duplicate them here.
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const byChars = Math.ceil(trimmed.length / 4);
  const byWords = trimmed.split(/\s+/).length;
  return Math.max(byChars, byWords);
}

/**
 * トップレベルの `# ` 見出しごとの見積もり（大きい順）。token-range の違反メッセージで「どこを削ればよいか」を示す（BL-210）。
 *
 * ⚠️ **見積もりは上の estimateTokens をそのまま使う**（書く側に別の見積もりを持たせない・同じ規則を2箇所に持たない）。
 * `##` 以下は親の `# ` に含める。見出しより前の本文は "(見出しの前)"。セクション別の合計は丸めの分だけ全体と一致しない（目安）。
 * コードブロック中の `# ` 行も見出しとして数える（目安なので許容）。
 */
export function estimateTokensBySection(text: string): Array<{ heading: string; tokens: number }> {
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } = { heading: "(見出しの前)", lines: [] };
  for (const line of text.split(/\r?\n/)) {
    if (/^# /.test(line)) {
      sections.push(current);
      current = { heading: line.trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, tokens: estimateTokens(s.lines.join("\n")) }))
    .filter((s) => s.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}
