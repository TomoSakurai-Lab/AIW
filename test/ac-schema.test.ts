// BL-113 — ac-manifest / ac-result の schema を json-schema validator へ配線する。
//
// 守っていること:
//   - 形式起因で fix ループを回さない（onViolation: report。halt しない）
//   - 「書かない自由」は optionalOutputs 宣言が担保（不在 = skipped、failed ではない）
//   - schema 不在の環境（この配線より前に init した環境）で黙って素通りしない
//   - pathBase の許容値は schema の enum、挙動（未知なら skipped）は validators.ts。
//     2 箇所の同期はテストで機械照合する（test 88 と同じ発想）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { runStep } from "../src/engine/engine.js";
import { KNOWN_PATH_BASES, runValidators } from "../src/engine/validators.js";
import { schemaVersionKey, versionInfo } from "../src/engine/versions.js";
import { makeRoot, setStep, validResult, writeIn, writeStatus } from "./helpers.js";

const ASSETS = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "assets");

// 実データ（archive/single/20260825T105050-task）を模した代表値。緩い版でしか通らない形
// （enum 外の evidenceKind / 注記の追加フィールド）を意図的に混ぜてある。
const realManifest = JSON.stringify({
  pathBase: "checkRepoRoot",
  acceptanceCriteria: [
    { id: "AC-01", evidenceKind: "browser" },
    { id: "AC-10", evidenceKind: "command", note: "書き手の善意の注記を違反にしない" },
    { id: "AC-11", evidenceKind: "screenshot" }
  ],
  consumerChecks: []
});
const realResult = JSON.stringify({
  results: [
    { id: "AC-01", status: "passed", evidenceKind: "browser", value: "coloredCellCount=1" },
    { id: "AC-08", status: "skipped", reason: "singleClickEdit のため検証条件を作れない" },
    { id: "AC-10", status: "failed", evidenceKind: "command", value: "exit 1（5 passed/2 failed）" }
  ]
});

// Test 118 — 出荷する workflow.yaml の配線が宣言どおり存在する（test 88 の schema 版）。
// implementation は ac-manifest / ac-result、fix は ac-result。全て report 宣言で、
// 参照する schema ファイルが assets に実在し、versions.schemas にも載っている。
test("118: shipped ac-* json-schema wiring exists, is report-declared, and is versioned", () => {
  const { config } = makeRoot();
  const yaml = readFileSync(path.join(ASSETS, "config", "workflow.yaml"), "utf8");

  const declared = (stepId: string): Array<{ target?: string; onViolation: string; schema?: string }> =>
    (config.steps[stepId].validators ?? []).filter((v: any) => v.type === "json-schema") as any;

  const impl = declared("implementation");
  assert.ok(impl.some((v) => v.target === "ac-manifest.json" && v.onViolation === "report"));
  assert.ok(impl.some((v) => v.target === "ac-result.json" && v.onViolation === "report"));
  const fix = declared("fix");
  assert.ok(fix.some((v) => v.target === "ac-result.json" && v.onViolation === "report"));
  // current-status の halt 宣言はそのまま（安全網を弱めていない）
  assert.ok(impl.some((v) => v.target === "current-status.json" && v.onViolation === "halt"));
  assert.ok(fix.some((v) => v.target === "current-status.json" && v.onViolation === "halt"));

  // 宣言された schema は assets に実在し、versions.schemas に版がある
  for (const stepId of ["implementation", "fix"]) {
    for (const v of declared(stepId)) {
      assert.ok(v.schema, `${stepId}: json-schema validator には schema 参照が要る`);
      const shipped = path.join(ASSETS, v.schema!);
      assert.ok(readFileSync(shipped, "utf8").length > 0, `${v.schema} must ship in assets`);
      assert.match(yaml, new RegExp(schemaVersionKey(v.schema!) + ":"), `versions.schemas.${schemaVersionKey(v.schema!)} must be declared`);
    }
  }
});

// Test 119 — 実データを模した ac-* は通り、緩い版の狙い（注記フィールド・enum 外の
// evidenceKind を違反にしない）が成立している。
test("119: representative real-world ac-* files pass the loose schemas", () => {
  const { root, config } = makeRoot();
  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  writeIn(root, "ac-manifest.json", realManifest);
  writeIn(root, "ac-result.json", realResult);
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });

  assert.equal(runStep(root, config, "implementation").kind, "transitioned");

  const completed = JSON.parse(
    readFileSync(path.join(root, "runs", "execution-log.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean)
      .map((l) => l)
      .filter((l) => l.includes("validation.completed"))[0]
  );
  const acResults = (completed.results as Array<{ type: string; status: string; target?: string }>).filter(
    (r) => r.type === "json-schema" && r.target !== "current-status.json"
  );
  assert.equal(acResults.length, 2, "ac-manifest と ac-result の両方が検査される");
  assert.ok(acResults.every((r) => r.status === "passed"), JSON.stringify(acResults));
});

// Test 120 — 壊れた ac-manifest は report に乗り、halt しない（形式起因で fix ループを回さない）。
// report の表示（notice）と Event Log への記録が既存の仕組みに乗ることも確認する。
test("120: a broken ac-manifest is reported, never halts, and reaches the Event Log", () => {
  const { root, config } = makeRoot();
  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  // minItems=1 違反（空 manifest は measurement-completeness を無言で無効化する実害枠）
  writeIn(root, "ac-manifest.json", JSON.stringify({ acceptanceCriteria: [] }));
  writeIn(root, "ac-result.json", realResult);
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });

  const out = runStep(root, config, "implementation");
  assert.equal(out.kind, "transitioned", "report 宣言は遷移を止めない");
  const notice = out.kind === "transitioned" ? out.notice : undefined;
  assert.ok(notice?.reported.some((r) => r.type === "json-schema" && /ac-manifest/.test(r.message)),
    `notice に ac-manifest の report が乗る: ${JSON.stringify(notice?.reported)}`);

  const log = readFileSync(path.join(root, "runs", "execution-log.jsonl"), "utf8");
  assert.match(log, /ac-manifest\.json schema violation/, "Event Log に違反が残る");
});

// Test 121 — 未知の pathBase は「書き手向け契約」（json-schema の report）と「実行時安全網」
// （consumer-presence が検査せず skipped）の両方に、同じ 1 回の実行で捕まる。
test("121: an unknown pathBase trips the schema report AND the consumer-presence skip", () => {
  const { root, config } = makeRoot();
  writeIn(root, "ac-manifest.json", JSON.stringify({
    pathBase: "runtimeRoot",
    acceptanceCriteria: [{ id: "AC-01", evidenceKind: "file" }],
    consumerChecks: [{ id: "API-01", root: "src", pattern: "x" }]
  }));
  writeIn(root, "ac-result.json", realResult);

  const validators = [
    ...(config.steps.implementation.validators ?? []).filter((v) => v.type === "json-schema" && v.target === "ac-manifest.json"),
    { type: "consumer-presence", onViolation: "report", manifest: "ac-manifest.json", result: "ac-result.json" } as const
  ];
  const outcome = runValidators(root, config, validators as any, { stepId: "implementation", fixAttempts: 0 });

  const schema = outcome.results.find((r) => r.type === "json-schema");
  const presence = outcome.results.find((r) => r.type === "consumer-presence");
  assert.equal(schema?.status, "failed", "書き手には schema violation として見える");
  assert.match(schema?.message ?? "", /pathBase/);
  assert.equal(presence?.status, "skipped", "安全網は検査せず skipped（偽陽性を出さない）");
  assert.match(presence?.skipReason ?? "", /unknown pathBase/);
  assert.equal(outcome.halt, false);
});

// Test 122 — 不在の扱い。optionalOutputs 宣言の target は skipped、必須 output は failed のまま。
// skipped の理由文字列は「optional target absent」で、schema 不在の理由と区別できる。
test("122: an absent optional target is skipped with its own reason; required targets still fail", () => {
  const { root, config } = makeRoot();
  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });

  const out = runStep(root, config, "implementation"); // ac-* を書いていない
  assert.equal(out.kind, "transitioned");
  const notice = out.kind === "transitioned" ? out.notice : undefined;
  const acSkips = (notice?.skipped ?? []).filter((s) => s.type === "json-schema");
  assert.equal(acSkips.length, 2, "ac-manifest / ac-result の不在は skipped ×2");
  assert.ok(acSkips.every((s) => /optional target absent/.test(s.skipReason ?? "")),
    `理由は optional target absent: ${JSON.stringify(acSkips)}`);
  assert.ok(acSkips.every((s) => !/schema file not found/.test(s.skipReason ?? "")),
    "schema 不在の理由文字列と混ざらない");

  // 必須 output（current-status.json）の不在は従来どおり failed → halt
  const second = makeRoot();
  setStep(second.root, "implementation");
  const outcome = runValidators(second.root, second.config, [
    { type: "json-schema", onViolation: "halt", target: "current-status.json", schema: "schemas/current-status.schema.json" }
  ] as any, { stepId: "implementation", fixAttempts: 0 });
  assert.equal(outcome.results[0].status, "failed");
  assert.match(outcome.results[0].message, /does not exist/);
});

// Test 123 — schema ファイルが無い環境（この配線より前に init した環境相当）。
// report 宣言 → skipped + 理由（黙って素通りしない）/ halt 宣言 → failed（安全網の構成
// エラーで止まる。current-status の検証が schema 1 ファイルの欠落で黙って外れない）。
test("123: a missing schema file is skipped for report validators and failed for halt validators", () => {
  const { root, config } = makeRoot();
  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  writeIn(root, "ac-manifest.json", realManifest);
  writeIn(root, "ac-result.json", realResult);
  rmSync(path.join(root, "schemas", "ac-manifest.schema.json"));
  rmSync(path.join(root, "schemas", "ac-result.schema.json"));
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });

  const out = runStep(root, config, "implementation");
  assert.equal(out.kind, "transitioned", "report 宣言の schema 欠落は遷移を止めない");
  const notice = out.kind === "transitioned" ? out.notice : undefined;
  const acSkips = (notice?.skipped ?? []).filter((s) => s.type === "json-schema");
  assert.equal(acSkips.length, 2);
  assert.ok(acSkips.every((s) => /schema file not found/.test(s.skipReason ?? "")),
    `理由が表示される: ${JSON.stringify(acSkips)}`);

  // halt 宣言側: current-status の schema が消えたら failed（skipped で素通りさせない）
  const outcome = runValidators(root, config, [
    { type: "json-schema", onViolation: "halt", target: "current-status.json", schema: "schemas/no-such.schema.json" }
  ] as any, { stepId: "implementation", fixAttempts: 0 });
  assert.equal(outcome.results[0].status, "failed");
  assert.equal(outcome.halt, true);
  assert.match(outcome.results[0].message, /schema file not found/);
});

// Test 124 — pathBase の許容値のドリフト防止。schema の enum（書き手向け契約の正本）と
// KNOWN_PATH_BASES（consumer-presence が解決を実装している基準）は機械照合で同期する。
// 新しい基準を足すときは、解決の実装・定数・schema の enum を同時に変えないとここで落ちる。
test("124: the schema pathBase enum and KNOWN_PATH_BASES cannot drift", () => {
  const schema = JSON.parse(readFileSync(path.join(ASSETS, "schemas", "ac-manifest.schema.json"), "utf8"));
  const enumValues = schema.properties?.pathBase?.enum;
  assert.ok(Array.isArray(enumValues), "shipped schema declares pathBase as an enum");
  assert.deepEqual([...enumValues].sort(), [...KNOWN_PATH_BASES].sort());
});

// Test 125 — versions.schemas は登録だけでなく Event Log に乗る。versionInfo が step の
// json-schema validator 宣言から動的に列挙する（登録して終わりの「宣言はあるが効いていない」を
// 作らない。BL-113 での新規追加）。
test("125: versionInfo enumerates every declared schema with version and hash", () => {
  const { root, config } = makeRoot();
  const info = versionInfo(root, config, "implementation");

  const bySchema = new Map(info.schemas.map((s) => [s.schema, s]));
  for (const ref of ["schemas/current-status.schema.json", "schemas/ac-manifest.schema.json", "schemas/ac-result.schema.json"]) {
    const entry = bySchema.get(ref);
    assert.ok(entry, `${ref} が列挙される`);
    assert.equal(entry.version, 1, `${ref} の版は versions.schemas から引ける`);
    assert.match(entry.hash ?? "", /^sha256:/, `${ref} のハッシュが記録される`);
  }
  // 既存の current-status 固定フィールドは互換のため残る
  assert.equal(info.schemaVersion, 1);
  assert.match(info.schemaHash ?? "", /^sha256:/);
  // キー変換の規約: schemas/<kebab>.schema.json -> versions.schemas.<camel>
  assert.equal(schemaVersionKey("schemas/ac-manifest.schema.json"), "acManifest");
  assert.equal(schemaVersionKey("schemas/current-status.schema.json"), "currentStatus");
});
