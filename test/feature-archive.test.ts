import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resume } from "../src/engine/completion.js";
import { runStep } from "../src/engine/engine.js";
import { defaultPostActions, type PostActionRegistry } from "../src/engine/postActions.js";
import { readState } from "../src/engine/state.js";
import { makeRoot, setStep, validFeature, writeIn, writeStatus } from "./helpers.js";

const METADATA = JSON.stringify(
  {
    featureId: "FEAT-x",
    featureName: "x",
    phaseId: "phase-b",
    phaseName: "b",
    taskName: "t",
    summary: "s",
    tags: ["infra"],
    metrics: {
      acceptanceCriteria: { pass: 1, fail: 0, notVerified: 0 },
      openDecisions: 0,
      manualVerificationRequired: 0,
      highRiskChanges: 0
    }
  },
  null,
  2
);

const featureFiles = (root: string, feature: string): string[] => {
  const dir = path.join(root, "archive", feature);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
};

const dateStamp = (): string => {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
};

// feature-complete archives feature.md under a date-stamped name and removes the working copy.
// Without this, a finished Phase list stays in the runtime root and the next task's Task Planning
// reads it as if the feature were still running.
test("archiveFeature: feature-complete files feature.md under archive/<feature>/<date>-feature-<id>.md", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection", { featureId: "FEAT-x", phase: "phase-b" });
  writeIn(root, "feature.md", validFeature(["phase-a", "phase-b"]));
  writeIn(root, "task-metadata.json", METADATA);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });

  const out = runStep(root, config, "reflection");
  assert.equal(out.kind, "transitioned");

  assert.deepEqual(featureFiles(root, "FEAT-x"), [`${dateStamp()}-feature-FEAT-x.md`]);
  assert.match(
    readFileSync(path.join(root, "archive", "FEAT-x", `${dateStamp()}-feature-FEAT-x.md`), "utf8"),
    /Phase list/,
    "the archived copy must be the feature.md content, not a blank"
  );
  assert.equal(existsSync(path.join(root, "feature.md")), false, "the working feature.md must be gone");
});

// A second feature completing on the same day must not overwrite the first: the date alone is not
// unique, so the name gets a numeric suffix rather than a longer stamp for every feature.
test("archiveFeature: a same-day second completion is suffixed, not overwritten", () => {
  const { root, config } = makeRoot();
  for (const phases of [["phase-a"], ["phase-b"]]) {
    setStep(root, "reflection", { featureId: "FEAT-x", phase: phases[0] });
    writeIn(root, "feature.md", validFeature(phases));
    writeIn(root, "task-metadata.json", METADATA);
    writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });
    assert.equal(runStep(root, config, "reflection").kind, "transitioned");
  }

  assert.deepEqual(featureFiles(root, "FEAT-x"), [
    `${dateStamp()}-feature-FEAT-x.md`,
    `${dateStamp()}-feature-FEAT-x-2.md`
  ].sort());
});

// feature-continue must leave feature.md in place — advancePhase still has to update it, and the
// next phase's Task Planning reads it.
test("archiveFeature: feature-continue leaves feature.md alone", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection", { featureId: "FEAT-x", phase: "phase-a" });
  writeIn(root, "feature.md", validFeature(["phase-a", "phase-b"]));
  writeIn(root, "task-metadata.json", METADATA);
  writeStatus(root, { step: "reflection", result: "feature-continue", reason: "next", nextPhaseId: "phase-b" });

  assert.equal(runStep(root, config, "reflection").kind, "transitioned");

  assert.ok(existsSync(path.join(root, "feature.md")), "feature.md must survive feature-continue");
  assert.match(readFileSync(path.join(root, "feature.md"), "utf8"), /Current phase: phase-b/);
  assert.deepEqual(featureFiles(root, "FEAT-x"), [], "nothing is filed on feature-continue");
});

// A phase of a multi-phase feature must be archived under the feature, not in single/. The engine
// never sets state.featureId, so the id has to come from task-metadata.json — and it must persist
// into the state draft so the next phase lands in the same directory.
test("archiveArtifacts: a feature's phases are archived under archive/<featureId>/", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "feature.md", validFeature(["phase-a", "phase-b"]));
  writeIn(root, "task-metadata.json", METADATA); // featureId: FEAT-x
  writeStatus(root, { step: "reflection", result: "feature-continue", reason: "next", nextPhaseId: "phase-b" });

  assert.equal(runStep(root, config, "reflection").kind, "transitioned");

  const dirs = readdirSync(path.join(root, "archive", "FEAT-x")).filter((f) => f.endsWith("-task"));
  assert.equal(dirs.length, 1, `expected the phase under archive/FEAT-x, got: ${dirs.join(", ")}`);
  assert.ok(
    existsSync(path.join(root, "archive", "FEAT-x", dirs[0], "current-status.json")),
    "the phase's artifacts must be in the feature directory"
  );
  assert.equal(
    existsSync(path.join(root, "archive", "single")),
    false,
    "nothing belonging to a feature may land in single/"
  );
  assert.match(readFileSync(path.join(root, "state.json"), "utf8"), /"featureId": "FEAT-x"/);
});

// A one-off task (featureId: null in its metadata) still goes to single/.
test("archiveArtifacts: a single task still goes to archive/single/", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "task-metadata.json", METADATA.replace('"featureId": "FEAT-x"', '"featureId": null'));
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });

  assert.equal(runStep(root, config, "reflection").kind, "transitioned");
  assert.ok(existsSync(path.join(root, "archive", "single")), "a task without a feature goes to single/");
});

// A single task leaves the seeded feature.md (no Phase list) in place: filing it would drop an
// empty file into archive/single/ after every single-task reflection AND delete the seed, so the
// next feature would start without its template.
test("archiveFeature: a single task leaves the seeded feature.md in place", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "task-metadata.json", METADATA);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });
  const seeded = existsSync(path.join(root, "feature.md"));

  assert.equal(runStep(root, config, "reflection").kind, "transitioned");
  assert.deepEqual(featureFiles(root, "single"), [], "a feature.md without phases is not filed");
  assert.equal(existsSync(path.join(root, "feature.md")), seeded, "the seed must survive untouched");
});

// ---------------------------------------------------------------------------------------------
// 2026-09-17: 冪等性（不変条件3）と 2 周目。コミット時の確認で見つかった resume の 2 つの穴を固定する。
// ---------------------------------------------------------------------------------------------

const featureCopies = (root: string, feature: string): string[] =>
  featureFiles(root, feature).filter((f) => /-feature(-.+)?\.md$/.test(f));

// Test 169 — discardTaskMetadata の後・archiveFeature の前で落ちて resume しても、同じ feature へ退避する。
// task-metadata.json はもう無いので、featureId の出どころは各 postAction 後のチェックポイント（state.json の draft）。
test("169: a resume after discardTaskMetadata still files feature.md under the same feature (the checkpoint carries featureId)", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "feature.md", validFeature(["phase-a"]));
  writeIn(root, "task-metadata.json", METADATA);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });

  let seenAtDiscard: string | null | undefined;
  let failOnce = true;
  const reg: PostActionRegistry = {
    ...defaultPostActions,
    discardTaskMetadata: (ctx) => {
      // archiveArtifacts の後のチェックポイントが、ディスクへ featureId を書いていること
      seenAtDiscard = readState(root).featureId;
      defaultPostActions.discardTaskMetadata(ctx);
    },
    archiveFeature: (ctx) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("crash before archiveFeature");
      }
      defaultPostActions.archiveFeature(ctx);
    }
  };

  assert.equal(runStep(root, config, "reflection", { postActions: reg }).kind, "halted");
  assert.equal(seenAtDiscard, "FEAT-x", "the checkpoint after archiveArtifacts must persist the resolved featureId");
  assert.equal(existsSync(path.join(root, "task-metadata.json")), false, "the source of featureId is already gone");

  assert.equal(resume(root, config, { postActions: reg }).kind, "transitioned");
  assert.deepEqual(featureCopies(root, "FEAT-x"), [`${dateStamp()}-feature-FEAT-x.md`]);
  assert.equal(existsSync(path.join(root, "archive", "single")), false, "nothing may fall back to single/");
  assert.equal(readState(root).featureId, null);
});

// Test 170 — feature.md を消した直後・チェックポイントの前で落ちても、resume で featureId がリセットされる。
// ⚠️ 最初の版は feature.md が無いと早期 return してリセットを飛ばし、次の単発タスクが完了済み feature の下へ退避されていた。
test("170: a crash after feature.md was removed but before the checkpoint still clears featureId on resume", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "feature.md", validFeature(["phase-a"]));
  writeIn(root, "task-metadata.json", METADATA);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });

  let failOnce = true;
  const reg: PostActionRegistry = {
    ...defaultPostActions,
    archiveFeature: (ctx) => {
      const before = ctx.draft.featureId;
      defaultPostActions.archiveFeature(ctx);
      if (failOnce) {
        failOnce = false;
        // プロセス死を模す: ファイル操作は済んだが、メモリ上のリセットはディスクに届いていない
        ctx.draft.featureId = before;
        throw new Error("crash before checkpoint");
      }
    }
  };

  assert.equal(runStep(root, config, "reflection", { postActions: reg }).kind, "halted");
  assert.equal(existsSync(path.join(root, "feature.md")), false);
  assert.equal(readState(root).featureId, "FEAT-x", "on disk the feature is still set (the last checkpoint)");

  assert.equal(resume(root, config, { postActions: reg }).kind, "transitioned");
  assert.equal(readState(root).featureId, null, "the reset must run even though there was nothing left to file");
  assert.deepEqual(featureCopies(root, "FEAT-x"), [`${dateStamp()}-feature-FEAT-x.md`]);
});

// Test 171 — コピーの後・削除の前で落ちても、resume で "-2" の重複を作らない。
test("171: a crash between the copy and the remove does not file a duplicate on resume", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "feature.md", validFeature(["phase-a"]));
  writeIn(root, "task-metadata.json", METADATA);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });

  let failOnce = true;
  const reg: PostActionRegistry = {
    ...defaultPostActions,
    archiveFeature: (ctx) => {
      if (failOnce) {
        failOnce = false;
        // コピーだけ済んだディスクの状態を作ってから落ちる
        const dir = path.join(root, "archive", "FEAT-x");
        mkdirSync(dir, { recursive: true });
        copyFileSync(path.join(root, "feature.md"), path.join(dir, `${dateStamp()}-feature-FEAT-x.md`));
        throw new Error("crash between copy and remove");
      }
      defaultPostActions.archiveFeature(ctx);
    }
  };

  assert.equal(runStep(root, config, "reflection", { postActions: reg }).kind, "halted");
  assert.equal(resume(root, config, { postActions: reg }).kind, "transitioned");
  assert.deepEqual(featureCopies(root, "FEAT-x"), [`${dateStamp()}-feature-FEAT-x.md`], "no -2 duplicate");
  assert.equal(existsSync(path.join(root, "feature.md")), false, "the original is still removed");
});

// Test 172 — 2 周目（new-artifact-checklist）: feature A 完了 → 単発タスク → feature B（2 フェーズ）完了。
// それぞれの分が別々に残り、前の feature の id が後ろへ漏れない。
test("172: two features completed in a row, with a single task between, each file into their own place", async () => {
  const { root, config } = makeRoot();
  const reflect = async (metadata: string, status: Record<string, unknown>, feature?: string[]): Promise<void> => {
    setStep(root, "reflection");
    if (feature) {
      writeIn(root, "feature.md", validFeature(feature));
    }
    writeIn(root, "task-metadata.json", metadata);
    writeStatus(root, { step: "reflection", reason: "r", ...status });
    assert.equal(runStep(root, config, "reflection").kind, "transitioned");
    // archiveArtifacts の退避先は秒単位のタイムスタンプ。同じ秒の 2 回は同じディレクトリへ入る（test 27b と同じ待ち）
    await new Promise((r) => setTimeout(r, 1100));
  };

  await reflect(METADATA, { result: "feature-complete" }, ["phase-a"]); // FEAT-x
  assert.equal(readState(root).featureId, null);
  await reflect(METADATA.replace('"featureId": "FEAT-x"', '"featureId": null'), { result: "feature-complete" }); // 単発
  assert.equal(readState(root).featureId, null);
  const y = METADATA.replace('"featureId": "FEAT-x"', '"featureId": "FEAT-y"');
  await reflect(y, { result: "feature-continue", nextPhaseId: "phase-b" }, ["phase-a", "phase-b"]);
  assert.equal(readState(root).featureId, "FEAT-y", "feature-continue keeps the feature for the next phase");
  await reflect(y, { result: "feature-complete" });

  const taskDirs = (feature: string): string[] => {
    const dir = path.join(root, "archive", feature);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith("-task")) : [];
  };
  assert.equal(taskDirs("FEAT-x").length, 1);
  assert.equal(taskDirs("single").length, 1, "the single task between the features is not filed under FEAT-x");
  assert.equal(taskDirs("FEAT-y").length, 2);
  assert.deepEqual(featureCopies(root, "FEAT-x"), [`${dateStamp()}-feature-FEAT-x.md`]);
  assert.deepEqual(featureCopies(root, "FEAT-y"), [`${dateStamp()}-feature-FEAT-y.md`]);
  assert.equal(readState(root).featureId, null);
});
