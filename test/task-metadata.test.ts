import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runStep } from "../src/engine/engine.js";
import { archivedTaskDirs, makeRoot, setStep, validResearchFindings, writeIn, writeStatus } from "./helpers.js";

const FILLED = JSON.stringify(
  {
    featureId: null,
    featureName: null,
    phaseId: null,
    phaseName: null,
    taskName: "add-task-metadata",
    summary: "Reflection が task-metadata.json を出すようにした。",
    tags: ["refactor", "infra"],
    metrics: {
      acceptanceCriteria: { pass: 3, fail: 0, notVerified: 1 },
      openDecisions: 0,
      manualVerificationRequired: 1,
      highRiskChanges: null
    }
  },
  null,
  2
);

// Test 24 — reflection's postActions archive task-metadata.json and THEN delete it.
// Order matters: archiveArtifacts runs before discardTaskMetadata, so the filled-in metadata
// reaches archive/<feature>/<task>/ before the working copy goes away.
test("24: task-metadata.json is archived, then discarded", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "task-metadata.json", FILLED);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });

  const out = runStep(root, config, "reflection");
  assert.equal(out.kind, "transitioned");

  // archived copy keeps what the AI wrote
  const dirs = archivedTaskDirs(root);
  assert.equal(dirs.length, 1, `expected one archived task dir, got: ${dirs.join(", ")}`);
  const archived = path.join(root, "archive", "single", dirs[0], "task-metadata.json");
  assert.ok(existsSync(archived), "task-metadata.json must be archived");
  assert.equal(readFileSync(archived, "utf8"), FILLED);

  // the working copy is GONE, not blanked. A blank template would satisfy the next reflection's
  // file-exists validator without anyone writing the metrics (M1 レビュー A-7).
  assert.equal(
    existsSync(path.join(root, "task-metadata.json")),
    false,
    "task-metadata.json must be discarded so the next reflection has to create it"
  );
});

// Test 25 — M1 レビュー A-7: a reflection that never wrote task-metadata.json must HALT.
// (This reverses the pre-M1 behaviour: archiveArtifacts silently skipped the absent file and
// restoreTemplates then overwrote it, so the metrics vanished without any signal.)
test("25: a missing task-metadata.json halts reflection instead of vanishing", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });
  assert.equal(existsSync(path.join(root, "task-metadata.json")), false);

  const out = runStep(root, config, "reflection");
  assert.equal(out.kind, "halted");
  assert.equal(out.kind === "halted" && out.reason, "validation-failed");
  assert.match(out.kind === "halted" ? out.message : "", /task-metadata\.json/);

  // the validator runs before postActions, so nothing destructive happened
  assert.deepEqual(archivedTaskDirs(root), [], "archiveArtifacts must not have run");
});

// Test 26b — M1 レビュー: research-findings.md must be archived before it is reset, otherwise the
// findings that current-review.md audited are gone as soon as the next research overwrites them.
test("26b: research-findings.md is archived, then reset from the template", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "task-metadata.json", FILLED);
  writeIn(root, "research-findings.md", validResearchFindings);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });

  const out = runStep(root, config, "reflection");
  assert.equal(out.kind, "transitioned");

  const dirs = archivedTaskDirs(root);
  assert.equal(dirs.length, 1, `expected one archived task dir, got: ${dirs.join(", ")}`);
  const archived = path.join(root, "archive", "single", dirs[0], "research-findings.md");
  assert.ok(existsSync(archived), "research-findings.md must be archived");
  assert.equal(readFileSync(archived, "utf8"), validResearchFindings, "archive keeps what research wrote");

  // working copy is reset, so the next task's research cannot inherit stale findings
  const working = readFileSync(path.join(root, "research-findings.md"), "utf8");
  assert.notEqual(working, validResearchFindings, "working copy must be reset");
  assert.equal(
    working,
    readFileSync(path.join(root, "templates", "research-findings.md"), "utf8"),
    "reset must come from the template"
  );
});

// Test 26 — task-metadata.json has no template: it is written fresh by every reflection and
// deleted after archiving, so restoreTemplates must not reference it.
test("26: task-metadata.json has no template and is not restored", () => {
  const { root, config } = makeRoot();
  assert.equal(
    existsSync(path.join(root, "templates", "task-metadata.json")),
    false,
    "a blank template would defeat reflection's file-exists validator"
  );
  assert.ok(
    config.steps["reflection"].postActions?.includes("discardTaskMetadata"),
    "reflection must discard the metadata after archiving"
  );

  // two reflections in a row: the second must halt because nothing recreated the file
  setStep(root, "reflection");
  writeIn(root, "task-metadata.json", FILLED);
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });
  assert.equal(runStep(root, config, "reflection").kind, "transitioned");

  setStep(root, "reflection");
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "x" });
  const second = runStep(root, config, "reflection");
  assert.equal(second.kind, "halted", "the 2nd reflection must not pass on a leftover blank file");
  assert.equal(second.kind === "halted" && second.reason, "validation-failed");
});

// Test 27b — KI-02: two consecutive reflections must produce two distinct archive directories.
// Before the fix the destination was archive/<featureId ?? "single">/<taskId ?? "task">, which is
// constant while featureId/taskId are null, and an existsSync early return then skipped the copy
// silently. Measured on the live root: 31 reflections, 2 archive dirs, ~30 tasks lost.
test("27b: consecutive reflections archive into distinct directories", async () => {
  const { root, config } = makeRoot();

  for (const label of ["task-one", "task-two"]) {
    setStep(root, "reflection");
    writeIn(root, "task-metadata.json", FILLED.replace("add-task-metadata", label));
    writeIn(root, "research-findings.md", `${validResearchFindings}\n<!-- ${label} -->\n`);
    writeStatus(root, { step: "reflection", result: "feature-complete", reason: label });
    assert.equal(runStep(root, config, "reflection").kind, "transitioned", `${label} must complete`);
    // the archive path is timestamped to the second; keep the two runs apart
    await new Promise((r) => setTimeout(r, 1100));
  }

  const dirs = archivedTaskDirs(root);
  assert.equal(dirs.length, 2, `expected 2 archived task dirs, got: ${dirs.join(", ")}`);

  // each directory holds its own task's artifacts — the second did not overwrite the first
  const names = dirs.map((d) =>
    JSON.parse(readFileSync(path.join(root, "archive", "single", d, "task-metadata.json"), "utf8")).taskName
  );
  assert.deepEqual([...names].sort(), ["task-one", "task-two"]);
});
