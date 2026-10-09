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
 * token-range の**目標帯**（BL-283・2026-10-09）。上限に対する割合で、validator の pass 条件には使わない（判定は上限・下限のまま）。
 *
 * 実測: research は上限を超えた下書きを 1 回 20〜100 ずつ削っては測り、上限の 97〜99% に着地していた（1 回の research で 3〜22 周。
 * 1 回は総上限 40 分で落ちた）。終了条件が「上限への漸近」だと周回が止まらないので、**やめ時として帯を与える**（締めるのではない）。
 * 値は上限から導く（上限を変えれば帯も動く。数値を workflow.yaml と二重に持たない）。
 */
export const TOKEN_TARGET_BAND = { low: 0.75, high: 0.9 } as const;

export function tokenTargetBand(min: number, max: number): { low: number; high: number } | null {
  if (!Number.isFinite(max)) return null;
  return { low: Math.max(min, Math.floor(max * TOKEN_TARGET_BAND.low)), high: Math.floor(max * TOKEN_TARGET_BAND.high) };
}

/** `aiw tokens` の判定文。超過時は「超過分」ではなく「帯の上端まで」を一度に削る量として出す。字数は estimateTokens の 4 字/トークンからの目安 */
export function describeTokenRange(tokens: number, min: number, max: number): string {
  const band = tokenTargetBand(min, max);
  const bandText = band ? `目標帯 ${band.low}〜${band.high}` : null;
  if (tokens > max) {
    const over = `上限を ${tokens - max} 超過`;
    if (!band) return over;
    const cut = tokens - band.high;
    return `${over}。${bandText} まで一度で削る（あと ${cut} 以上・目安 約 ${cut * 4} 字）`;
  }
  if (tokens < min) return `下限に ${min - tokens} 不足`;
  const inRange = `範囲内（上限まで ${max - tokens}・上限の ${Math.round((tokens / max) * 100)}%）`;
  if (!band || tokens < band.low) return inRange;
  return tokens <= band.high
    ? `${inRange}。${bandText} の中——削るのをやめる`
    : `${inRange}。${bandText} より上だが上限内——削らなくてよい`;
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
