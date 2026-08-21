// `aiw log` の読み取り側（M3・課題I）。
//
// 検証の中心は「整形できること」ではなく:
//   - **読むだけで、新しい記録を作らない**
//   - **生 session ID を出さない**（不変条件6。表示経路が1つ増えたので対象も増える）
//   - **シェルの本体が見える**（試作で「インタプリタのパスで文字数を使い切る」不備を踏んだ）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findRunFile, formatRunLog, readRunLog, shellBody, startedAtFromName } from "../src/engine/codexLog.js";
import { rootPaths } from "../src/engine/paths.js";
import { makeRoot } from "./helpers.js";

const THREAD_ID = "01a0221e-c728-79a2-bba1-06317ed9270c";

function writeRun(root: string, name: string, events: unknown[]): string {
  const dir = path.join(rootPaths(root).runsDir, "codex");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
}

const RUN = [
  { type: "thread.started", thread_id: THREAD_ID },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "i0", type: "agent_message", text: "まず3入力を\n確認します。" } },
  {
    type: "item.completed",
    item: {
      id: "i1",
      type: "command_execution",
      exit_code: 0,
      command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'git status --short\''
    }
  },
  { type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: "C:/x/src/Grid.tsx" }, { path: "a\\b\\Hub.cs" }] } },
  { type: "error", message: `flaky ${THREAD_ID}` },
  { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } }
];

// Test 109 — **直近の実行を選ぶ。** ファイル名の先頭が ISO 時刻なので辞書順＝時刻順。
test("109: log picks the most recent run for the step and reads it without writing", () => {
  const { root } = makeRoot();
  writeRun(root, "2026-08-20T01-00-00-000Z-implementation.jsonl", RUN);
  const newest = writeRun(root, "2026-08-21T02-20-36-853Z-implementation.jsonl", RUN);
  writeRun(root, "2026-08-21T03-00-00-000Z-fix.jsonl", RUN); // 別ステップは選ばない

  assert.equal(findRunFile(root, "implementation"), newest);
  assert.equal(findRunFile(root, "review"), null, "記録が無いステップは null");

  // **読むだけ**: 呼んでもファイルが増減しない
  const before = readdirSync(path.join(rootPaths(root).runsDir, "codex")).sort();
  readRunLog(root, newest);
  assert.deepEqual(readdirSync(path.join(rootPaths(root).runsDir, "codex")).sort(), before, "新しい記録を作らない");

  assert.equal(startedAtFromName(newest), "2026-08-21T02:20:36.853Z", "時刻はファイル名から復元する");
});

// Test 110 — **生 session ID を出さない。** 表示経路が増えたので防衛線2の対象も増える。
test("110: the rendered log never contains the raw session id", () => {
  const { root } = makeRoot();
  const file = writeRun(root, "2026-08-21T02-20-36-853Z-implementation.jsonl", RUN);
  const log = readRunLog(root, file);

  assert.equal(JSON.stringify(log).includes(THREAD_ID), false, "構造化出力(--json)に生 ID があってはいけない");
  assert.equal(formatRunLog(log).includes(THREAD_ID), false, "人間可読の出力にも出さない");
  assert.equal(log.session?.tail, "270c", "末尾だけは照合のために残す");
  assert.match(log.session?.hash ?? "", /^sha256:[0-9a-f]{64}$/);

  // ⚠️ 境界: **生 JSONL には thread_id が入ったまま**。--raw はその一次資料をそのまま出す。
  // 防衛対象は aiw が整形・転記する側であって、保存物そのものではない。
  assert.equal(readFileSync(file, "utf8").includes(THREAD_ID), true);
});

// Test 111 — **シェルは本体が見える。** インタプリタのパスで文字数を使い切らない。
//
// 試作段階では全行が `"C:\WINDOWS\System32\WindowsPowerShell\v1.0\po…` で切れ、
// 肝心のコマンドが読めなかった。実データで踏んだ不備なのでここで固定する。
test("111: a shell entry shows the command body, not the interpreter path", () => {
  const ps = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'git status --short\'';
  assert.equal(shellBody(ps), "git status --short");
  assert.equal(shellBody(["bash", "-c", "npm test"]), "npm test");
  assert.equal(shellBody("rg -n TODO src"), "rg -n TODO src", "-Command が無ければそのまま");

  const { root } = makeRoot();
  const file = writeRun(root, "2026-08-21T02-20-36-853Z-implementation.jsonl", RUN);
  const rendered = formatRunLog(readRunLog(root, file));
  assert.match(rendered, /git status --short \(exit 0\)/);
  assert.equal(rendered.includes("WindowsPowerShell"), false, "インタプリタのパスは出さない");
});

// Test 112 — 整形の中身: 発言は1行へ畳み、編集は basename、集計と usage を出す。
test("112: the rendering folds messages, shortens paths, and totals the run", () => {
  const { root } = makeRoot();
  const file = writeRun(root, "2026-08-21T02-20-36-853Z-implementation.jsonl", RUN);
  const log = readRunLog(root, file);

  assert.deepEqual(
    log.entries.map((e) => e.kind),
    ["say", "shell", "edit", "error"],
    "thread.started と turn.completed は行にしない（メタ情報として持つ）"
  );
  assert.equal(log.entries[0].text, "まず3入力を 確認します。", "改行を潰して1行にする");
  assert.deepEqual(log.entries[2].files, ["Grid.tsx", "Hub.cs"], "パス区切りは / でも \\ でも basename にする");
  assert.deepEqual(log.counts, { say: 1, edit: 1, shell: 1, think: 0, error: 1, other: 0 });

  const out = formatRunLog(log);
  assert.match(out, /say 1 \/ edit 1 \/ shell 1 \/ error 1/);
  assert.match(out, /tokens in 1,000 \/ out 50 {2}cacheRead 90%/, "cacheRead 比まで出す（§2 の指標）");
});

// Test 113 — 壊れた行があっても読み進める（一次資料なので途中で止めない）。
test("113: a malformed line is skipped, not fatal", () => {
  const { root } = makeRoot();
  const dir = path.join(rootPaths(root).runsDir, "codex");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "2026-08-21T02-20-36-853Z-implementation.jsonl");
  writeFileSync(
    file,
    [JSON.stringify(RUN[2]), "{ this is not json", "", JSON.stringify(RUN[4])].join("\n"),
    "utf8"
  );

  const log = readRunLog(root, file);
  assert.deepEqual(log.entries.map((e) => e.kind), ["say", "edit"], "壊れた行だけ落として続ける");
});
