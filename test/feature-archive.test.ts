import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { runStep } from "../src/engine/engine.js";
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
