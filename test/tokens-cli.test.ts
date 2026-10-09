// `aiw tokens`（2026-10-06）: token-range の validator と同じ見積もりで測る、読むだけのコマンド。
//
// 実測: research は上限に収めるために自前の `wc -c` などで近似して測っては削るのを 16 周繰り返し、実行の約 3 分の 1 を使っていた。
// 書く側に別の見積もりを持たせない（BL-210）ため、validator の関数そのものを呼ぶ口を用意した。ここでは
// 「validator と同じ値を出す」「宣言のあるファイルには範囲と残りを出す」「ファイルを書かない」を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeTokenRange, estimateTokens, estimateTokensBySection, tokenTargetBand } from "../src/engine/tokens.js";
import { runValidators } from "../src/engine/validators.js";
import { makeRoot, validContextPackage } from "./helpers.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function aiw(root: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(PKG, "node_modules", "tsx", "dist", "cli.js"), path.join(PKG, "src", "cli.ts"), "--root", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    cwd: PKG
  });
  assert.equal(r.error, undefined, `aiw を起動できない: ${r.error?.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Test 236 — validator と同じ値・範囲と残り・セクション別の内訳。ファイルを書かない。
test("236: aiw tokens reports the validator's own estimate, the declared range, and the per-section breakdown", () => {
  const { root, config } = makeRoot();
  const file = path.join(root, "context-package.md");
  const text = validContextPackage();
  writeFileSync(file, text, "utf8");
  const before = statSync(file).mtimeMs;
  const tokenRange = config.steps["research"].validators!.find((v) => v.type === "token-range")!;

  const out = aiw(root, "tokens", file, "--json");
  assert.equal(out.status, 0, out.stderr);
  const [r] = JSON.parse(out.stdout);
  assert.equal(r.tokens, estimateTokens(text), "validator の見積もり関数と同じ値");
  assert.deepEqual(r.sections, estimateTokensBySection(text), "内訳も同じ関数");
  assert.equal(r.range.min, tokenRange.min);
  assert.equal(r.range.max, tokenRange.max);
  assert.match(r.status, /^範囲内（上限まで \d+・上限の \d+%）$/);
  // 同じファイルを validator に当てても通る（コマンドの「範囲内」と validator の判定が一致する）
  const v = runValidators(root, config, [tokenRange]);
  assert.equal(v.violations.length, 0);

  // 人間向けの表示: 1 行目に合計と範囲、2 行目に内訳
  const plain = aiw(root, "tokens", file);
  assert.match(plain.stdout, new RegExp(`~${r.tokens} tokens  token-range \\[${tokenRange.min}, ${tokenRange.max}\\]（research）: 範囲内`));
  assert.match(plain.stdout, /セクション別の見積もり・大きい順: # /);

  // 宣言の無いファイルにも見積もりは出す。存在しないファイルは exit 1
  writeFileSync(path.join(root, "notes.md"), "# A\nhello\n", "utf8");
  assert.match(aiw(root, "tokens", path.join(root, "notes.md")).stdout, /（token-range の宣言なし）/);
  assert.equal(aiw(root, "tokens", path.join(root, "nope.md")).status, 1);

  assert.equal(statSync(file).mtimeMs, before, "読むだけ（ファイルを書かない）");
  assert.equal(readFileSync(file, "utf8"), text);
});

// Test 238 — BL-283: 目標帯（上限の 75〜90%）。やめ時を与えるだけで、判定（validator の pass 条件）は上限・下限のまま。
// 超過時は「超過分」ではなく「帯の上端まで」を一度に削る量として出す（1 回 20〜100 ずつ削って上限の 97〜99% に張り付く山登りを止める）。
test("238: aiw tokens shows a target band derived from the max, without changing the validator's verdict", () => {
  assert.deepEqual(tokenTargetBand(250, 1500), { low: 1125, high: 1350 });
  assert.equal(tokenTargetBand(0, Number.POSITIVE_INFINITY), null, "上限の無い宣言には帯を出さない");

  assert.equal(describeTokenRange(1700, 250, 1500), "上限を 200 超過。目標帯 1125〜1350 まで一度で削る（あと 350 以上・目安 約 1400 字）");
  assert.equal(describeTokenRange(1450, 250, 1500), "範囲内（上限まで 50・上限の 97%）。目標帯 1125〜1350 より上だが上限内——削らなくてよい");
  assert.equal(describeTokenRange(1300, 250, 1500), "範囲内（上限まで 200・上限の 87%）。目標帯 1125〜1350 の中——削るのをやめる");
  assert.equal(describeTokenRange(900, 250, 1500), "範囲内（上限まで 600・上限の 60%）");
  assert.equal(describeTokenRange(100, 250, 1500), "下限に 150 不足");

  // 帯の外（上限内）のファイルも validator は通す——帯は判定に入っていない
  const { root, config } = makeRoot();
  const tokenRange = config.steps["research"].validators!.find((v) => v.type === "token-range")!;
  const file = path.join(root, "context-package.md");
  let text = validContextPackage();
  while (estimateTokens(text) <= Math.floor(tokenRange.max! * 0.9)) text += "\nfiller filler filler filler";
  assert.ok(estimateTokens(text) <= tokenRange.max!, "テストの前提: 帯より上・上限内");
  writeFileSync(file, text, "utf8");
  assert.equal(runValidators(root, config, [tokenRange]).violations.length, 0, "帯より上でも上限内なら pass");
  const [r] = JSON.parse(aiw(root, "tokens", file, "--json").stdout);
  assert.deepEqual(r.target, tokenTargetBand(tokenRange.min ?? 0, tokenRange.max!));
  assert.match(r.status, /削らなくてよい$/);
});
