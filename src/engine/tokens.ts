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

/**
 * `aiw tokens` の判定文。帯より上なら（上限の内外を問わず）「帯の上端まで」を一度に削る量として出す。字数は estimateTokens の 4 字/トークンからの目安。
 *
 * ⚠️ 2026-10-15 訂正（BL-283）: 初版は上限内・帯より上を「削らなくてよい」と出していた。これが出口になり、research は上限の直下まで
 * 小刻みに削ったところで止まり続けた（10-09〜15 の 12 回中、帯に入ったのは 1 回）。設計は「帯に入ったら削るのをやめる」で、上限内に出口は無い。
 */
export function describeTokenRange(tokens: number, min: number, max: number): string {
  const band = tokenTargetBand(min, max);
  const bandText = band ? `目標帯 ${band.low}〜${band.high}` : null;
  // BL-283 (ii)・2026-10-19: 帯の端ではなく中央を目標にし、削る量はセクション別の割り当て（allocateCuts）で示す
  const cutToBand = (t: number, b: { low: number; high: number }): string => {
    const goal = bandCenter(b);
    const cut = t - goal;
    return `${bandText} の中央 ${goal} まで、下の割り当てどおり各セクションを1回ずつ削る（合計 あと ${cut}・目安 約 ${cut * 4} 字）`;
  };
  if (tokens > max) {
    const over = `上限を ${tokens - max} 超過`;
    return band ? `${over}。${cutToBand(tokens, band)}` : over;
  }
  if (tokens < min) return `下限に ${min - tokens} 不足`;
  const inRange = `範囲内（上限まで ${max - tokens}・上限の ${Math.round((tokens / max) * 100)}%）`;
  if (!band || tokens < band.low) return inRange;
  return tokens <= band.high ? `${inRange}。${bandText} の中——削るのをやめる` : `${inRange}。${cutToBand(tokens, band)}`;
}

function bandCenter(band: { low: number; high: number }): number {
  return Math.round((band.low + band.high) / 2);
}

/**
 * 削減の割り当て案（BL-283 (ii)・2026-10-19）。帯より上のとき、帯の中央まで削る量を**各セクションの大きさに比例して**割り当てる（大きい順に並べる）。
 * 帯の中・帯より下・帯が無いときは null。
 *
 * 実測（v8→v9→v10）: どこに線を引いても research は「削っては測る」を小刻みに繰り返し、線まで漸近した。しきい値ではなく行動の問題で、
 * 残った仮説は「どこをどれだけ削るか決めずに削っている」。割り当てを先に渡し、各セクションを1回ずつ書き直してから1回だけ測る形にする。
 * ⚠️ 案であって判定ではない（validator の pass 条件は上限・下限のまま）。比例は丸めの余りを大きいセクションから1ずつ配る。
 */
export function allocateCuts(
  tokens: number,
  min: number,
  max: number,
  sections: Array<{ heading: string; tokens: number }>
): { goal: number; total: number; cuts: Array<{ heading: string; tokens: number; cut: number; to: number }> } | null {
  const band = tokenTargetBand(min, max);
  if (!band || tokens <= band.high) return null;
  const goal = bandCenter(band);
  const need = tokens - goal;
  const sorted = [...sections].filter((s) => s.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const sum = sorted.reduce((n, s) => n + s.tokens, 0);
  if (sum === 0) return null;
  const cuts = sorted.map((s) => ({ heading: s.heading, tokens: s.tokens, cut: Math.floor((s.tokens * need) / sum) }));
  let rest = need - cuts.reduce((n, c) => n + c.cut, 0);
  while (rest > 0) {
    let progressed = false;
    for (const c of cuts) {
      if (rest > 0 && c.cut < c.tokens) {
        c.cut++;
        rest--;
        progressed = true;
      }
    }
    if (!progressed) break; // 削れる量を使い切った（見出しの合計が帯の中央まで届かない・丸めの差）
  }
  return { goal, total: need, cuts: cuts.filter((c) => c.cut > 0).map((c) => ({ ...c, to: c.tokens - c.cut })) };
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
