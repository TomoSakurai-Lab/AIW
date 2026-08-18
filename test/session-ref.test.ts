// セッション識別子の型分離（M3・不変条件6）。
//
// 不変条件6 は CLAUDE.md で **強制: なし** の項目だった。M3 で初めて破れるコードが生まれる
// （codex の JSONL に thread_id が入り、段階1でもログ経路に乗る）ので、
// ここが最初の強制になる。
//
// 検証の中心は「hash が作れること」ではなく **「生の値がログ経路へ出せないこと」**。
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSession, sessionSecret, toSessionRef } from "../src/engine/session.js";

const RAW = "01a013b1-80e9-7c71-9460-305caf414464";

// Test 89 — SessionRef は hash と tail しか持たない。生の値を運べない。
test("89: a SessionRef carries only a hash and a tail, never the raw id", () => {
  const ref = toSessionRef(sessionSecret(RAW));

  assert.deepEqual(Object.keys(ref).sort(), ["hash", "tail"], "他のキーを増やさない");
  assert.match(ref.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(ref.tail, "4464", "末尾4文字のみ");

  // **JSON 化しても生の値が出てこない**（Event Log へ載るのはこの形）
  const serialized = JSON.stringify(ref);
  assert.equal(serialized.includes(RAW), false, "生 ID が混ざってはいけない");
  assert.equal(serialized.includes(RAW.slice(0, 8)), false, "先頭も出さない");
});

// Test 90 — 同じ生 ID は同じ hash、違う生 ID は違う hash（照合に使えること）。
test("90: the hash identifies a session without revealing it", () => {
  const a = toSessionRef(sessionSecret(RAW));
  const b = toSessionRef(sessionSecret(RAW));
  const c = toSessionRef(sessionSecret("01a013b3-c3e3-7430-a017-1660e71564d6"));

  assert.equal(a.hash, b.hash, "同一セッションは同じ hash になる");
  assert.notEqual(a.hash, c.hash);
});

// Test 91 — **表示経路の最後の砦。** codex のイベント文字列に生 ID が紛れても伏せる。
test("91: redactSession masks a raw id that leaked into a display string", () => {
  const secret = sessionSecret(RAW);
  const line = `thread ${RAW} started; resuming ${RAW}`;

  const safe = redactSession(line, secret);
  assert.equal(safe.includes(RAW), false, "生 ID が残ってはいけない");
  assert.equal(safe, "thread <session:4464> started; resuming <session:4464>", "出現箇所を全て伏せる");

  // secret が無いときは素通し（伏せる対象が分からないため）
  assert.equal(redactSession(line, null), line);
});

// Test 92 — **戻す関数を生やさない。** SessionRef から生の値を復元できないこと。
//
// これは実装の詳細ではなく設計の要。復元関数を足した時点で型分離は無意味になるので、
// 「モジュールの公開面に raw を返すものが無い」を検査する。
test("92: the session module exposes no way back to the raw id", async () => {
  const mod = await import("../src/engine/session.js");
  const exported = Object.keys(mod).sort();
  assert.deepEqual(exported, ["redactSession", "sessionSecret", "toSessionRef"], "公開面を増やさない");

  // toSessionRef の戻り値に raw を含むプロパティが無いことは Test 89 で見ている。
  // ここでは「SessionRef を受けて string を返す関数」が公開されていないことを見る。
  const ref = toSessionRef(sessionSecret(RAW));
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== "function" || name === "redactSession") {
      continue;
    }
    // sessionSecret / toSessionRef に SessionRef を渡しても生の値は出てこない
    let out: unknown;
    try {
      out = (fn as (x: unknown) => unknown)(ref);
    } catch {
      continue;
    }
    assert.equal(JSON.stringify(out ?? "").includes(RAW), false, `${name} が生 ID を返している`);
  }
});
