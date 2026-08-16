// Prompt Decomposition の組み立て機構（M2 Stage 2）。
//
// 検証の中心は「結合できること」ではなく **「欠落が静かに起きないこと」**。
// Skill が消えたときに黙って Skill 抜きで組み立てるのは、このコードベースで繰り返してきた
// 同型のバグ（KI-09）なので、そこをテストで固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClipboardExecutor } from "../src/engine/executors/clipboard.js";
import { assembleStepPrompt, PromptAssemblyError } from "../src/engine/promptAssembly.js";
import { versionInfo } from "../src/engine/versions.js";
import { makeRoot } from "./helpers.js";
import type { WorkflowStep } from "../src/engine/types.js";

function putSkill(root: string, name: string, body: string): void {
  const dir = path.join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

function putInstruction(root: string, name: string, body: string): void {
  const dir = path.join(root, "instructions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), body, "utf8");
}

function stepWith(base: WorkflowStep, patch: Partial<WorkflowStep>): WorkflowStep {
  return { ...base, ...patch };
}

// Stage 3 で assets 側の宣言が増えていくため、宣言そのものを検証するテストは
// 実際の workflow.yaml の宣言状態に依存しないよう、いったん剥がしてから組み立てる。
function undeclared(base: WorkflowStep): WorkflowStep {
  const { skill, instructions, optionalInstructions, ...rest } = base;
  return rest as WorkflowStep;
}

// Test 81 — 宣言あり + ファイルあり → 宣言順に結合される。
//
// この順序固定は回帰防止ではなく **M3 のコスト構造の防衛線**。一般 → 固有に並べているため
// 先頭からの共通接頭辞が最大になり、prompt caching の cache breakpoint をそのまま
// instructions / skill / step の境界へ置ける。順序を変えるとステップごとに接頭辞が変わり
// キャッシュヒットが失われる。緩める前に docs/m3-design-inputs.md を読むこと。
test("81: declared skill and instructions are assembled in a fixed order", () => {
  const { root, config } = makeRoot();
  putInstruction(root, "coding-rules", "RULES-BODY");
  putSkill(root, "implementation", "SKILL-BODY");

  const step = stepWith(config.steps["implementation"], {
    skill: "implementation",
    instructions: ["coding-rules"]
  });
  const a = assembleStepPrompt(root, "implementation", step);

  assert.deepEqual(a.parts.map((p) => p.kind), ["instructions", "skill", "step"], "一般 → 固有の順");
  assert.deepEqual(a.omitted, []);

  // 本文が全て含まれ、順序が固定であること
  const iRules = a.text.indexOf("RULES-BODY");
  const iSkill = a.text.indexOf("SKILL-BODY");
  const iStep = a.text.indexOf("# Current Phase");
  assert.ok(iRules >= 0 && iSkill > iRules && iStep > iSkill, `order broken: ${iRules}/${iSkill}/${iStep}`);
  assert.match(a.text, /assembled by aiw: instructions\/coding-rules\.md \+ skills\/implementation\/SKILL\.md \+ prompts\/implementation\.md/);
});

// Test 82 — **宣言あり + ファイルなし → エラー。** 静かに Skill 抜きで組み立てない。
test("82: a declared-but-missing skill or instruction is an error, never a silent omission", () => {
  const { root, config } = makeRoot();
  const base = undeclared(config.steps["implementation"]);

  assert.throws(
    () => assembleStepPrompt(root, "implementation", stepWith(base, { skill: "ghost" })),
    (e: Error) => e instanceof PromptAssemblyError && /declares skill "ghost"/.test(e.message)
  );

  putSkill(root, "ghost", "SKILL-BODY");
  assert.throws(
    () => assembleStepPrompt(root, "implementation", stepWith(base, { skill: "ghost", instructions: ["ghost-rules"] })),
    (e: Error) => e instanceof PromptAssemblyError && /declares instructions "ghost-rules"/.test(e.message)
  );

  // エラーメッセージは「組み立てられていない」ことを明言する
  try {
    assembleStepPrompt(root, "implementation", stepWith(base, { instructions: ["nope"] }));
    assert.fail("should have thrown");
  } catch (e) {
    assert.match((e as Error).message, /prompt is NOT assembled without it/);
  }
});

// Test 83 — 宣言なし → 従来出力と完全に同一（後方互換）。
test("83: a step with no declarations produces the untouched prompt body", () => {
  const { root, config } = makeRoot();
  const raw = readFileSync(path.join(root, "prompts", "implementation.md"), "utf8").replace(/\s+$/, "");

  const a = assembleStepPrompt(root, "implementation", undeclared(config.steps["implementation"]));
  assert.equal(a.text, raw, "結合ヘッダも区切りも足さない");
  assert.deepEqual(a.parts.map((p) => p.kind), ["step"]);

  // step 自体を渡さない場合も同じ
  assert.equal(assembleStepPrompt(root, "implementation").text, raw);
});

// Test 84 — **optionalInstructions（local-environment）は不在でもエラーにしないが、
// 省略したことを出力に残す。** 「不在は大きな音を立てる」原則への唯一の例外なので、
// 静かな除外にならないことをここで固定する。
test("84: a missing optional instruction is tolerated but recorded in the output", () => {
  const { root, config } = makeRoot();
  putSkill(root, "implementation", "SKILL-BODY");
  const step = stepWith(undeclared(config.steps["implementation"]), {
    skill: "implementation",
    optionalInstructions: ["local-environment"]
  });

  const missing = assembleStepPrompt(root, "implementation", step);
  assert.deepEqual(missing.omitted, ["local-environment.md"], "省略を記録する");
  assert.match(missing.text, /\(no local-environment\.md\)/, "出力にも1行残す");
  assert.equal(missing.parts.some((p) => p.kind === "local-environment"), false);

  // 存在すれば結合され、省略の注記は出ない
  putInstruction(root, "local-environment", "LOCAL-ENV-BODY");
  const present = assembleStepPrompt(root, "implementation", step);
  assert.deepEqual(present.omitted, []);
  assert.match(present.text, /LOCAL-ENV-BODY/);
  assert.doesNotMatch(present.text, /\(no local-environment\.md\)/);
  assert.deepEqual(present.parts.map((p) => p.kind), ["local-environment", "skill", "step"]);
});

// Test 85 — clipboard executor が組み立て結果を配る。欠落時は executor ごと失敗する。
test("85: the clipboard executor ships the assembled prompt and fails loudly on a gap", async () => {
  const { root, config } = makeRoot();
  putInstruction(root, "coding-rules", "RULES-BODY");
  putSkill(root, "review", "REVIEW-SKILL");
  const written: string[] = [];
  const executor = createClipboardExecutor({ write: async (t) => void written.push(t) });

  const step = stepWith(config.steps["review"], { skill: "review", instructions: ["coding-rules"] });
  const ok = await executor.execute({ root, config, step });
  assert.equal(ok.ok, true);
  assert.match(written[0], /RULES-BODY/);
  assert.match(written[0], /REVIEW-SKILL/);

  // Skill を消すと executor は例外を投げる（Skill 抜きの本文を配らない）
  rmSync(path.join(root, "skills", "review"), { recursive: true, force: true });
  await assert.rejects(
    () => executor.execute({ root, config, step }),
    (e: Error) => e instanceof PromptAssemblyError
  );
  assert.equal(written.length, 1, "失敗時にクリップボードを書き換えない");
});

// Test 86 — Skill / Instructions のバージョンと hash が Event Log 用に取れる。
// どの Skill バージョンで走ったかが分からないと M2.6 の計測が成立しない。
test("86: skill and instruction versions/hashes are recorded for the Event Log", () => {
  const { root, config } = makeRoot();
  putSkill(root, "implementation", "SKILL-BODY");
  putInstruction(root, "coding-rules", "RULES-BODY");

  const cfg = {
    ...config,
    versions: { ...(config.versions ?? {}), skills: { implementation: 1 }, instructions: { "coding-rules": 1 } },
    steps: {
      ...config.steps,
      implementation: stepWith(config.steps["implementation"], {
        skill: "implementation",
        instructions: ["coding-rules"],
        optionalInstructions: ["local-environment"]
      })
    }
  };

  const v = versionInfo(root, cfg, "implementation");
  assert.equal(v.skill, "implementation");
  assert.equal(v.skillVersion, 1);
  assert.ok(v.skillHash?.startsWith("sha256:"));
  assert.deepEqual(v.instructions.map((i) => i.name), ["coding-rules"], "不在の optional は載せない");
  assert.equal(v.instructions[0].version, 1);
  assert.ok(v.instructions[0].hash?.startsWith("sha256:"));

  // 宣言のないステップでは null / 空
  cfg.steps["review-audit"] = undeclared(cfg.steps["review-audit"]);
  const none = versionInfo(root, cfg, "review-audit");
  assert.equal(none.skill, null);
  assert.equal(none.skillHash, null);
  assert.deepEqual(none.instructions, []);
});

// Test 88 — **出荷している workflow.yaml の宣言が実際に組み立て可能であること。**
// Stage 3 で1ステップずつ分解していく間、「yaml に宣言したがファイルを assets へ
// 入れ忘れた」が本番で初めて分かるのを防ぐ。宣言済みの全ステップを実際に組み立てる。
test("88: every skill/instruction declared in the shipped workflow.yaml resolves", () => {
  const { root, config } = makeRoot();
  const declared = Object.values(config.steps).filter((s) => s.skill || s.instructions?.length);
  assert.ok(declared.length > 0, "Stage 3 が進めば必ず1件以上ある");

  for (const step of declared) {
    const a = assembleStepPrompt(root, step.id, step);
    if (step.skill) {
      assert.ok(
        a.parts.some((p) => p.kind === "skill"),
        `${step.id}: skills/${step.skill}/SKILL.md が assets に無い`
      );
    }
    for (const name of step.instructions ?? []) {
      assert.ok(
        a.parts.some((p) => p.kind === "instructions" && p.name === name),
        `${step.id}: instructions/${name}.md が assets に無い`
      );
    }
    // 宣言したステップは versions にも載せる(Event Log で版が追えなくなるため)
    const versions = (config.versions ?? {}) as any;
    if (step.skill) {
      assert.equal(typeof versions.skills?.[step.skill], "number", `versions.skills.${step.skill} が無い`);
    }
    for (const name of step.instructions ?? []) {
      assert.equal(typeof versions.instructions?.[name], "number", `versions.instructions.${name} が無い`);
    }
  }
});

// Test 87 — `aiw init` が skills / instructions を作る（assets にあれば複製される）。
test("87: init scaffolds the skills and instructions directories", () => {
  const { root } = makeRoot();
  for (const dir of ["skills", "instructions"]) {
    assert.ok(statSync(path.join(root, dir)).isDirectory(), `${dir}/ が作られていない`);
  }
  // local-environment.md は runtime 専用。assets 由来で入ってきてはいけない（KI-01 の解消）。
  assert.equal(
    existsSync(path.join(root, "instructions", "local-environment.md")),
    false,
    "環境固有ファイルを assets から配ってはいけない"
  );
});
