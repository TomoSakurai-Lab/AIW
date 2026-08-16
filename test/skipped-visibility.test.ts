import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { runStep } from "../src/engine/engine.js";
import { buildObserved, currentTaskWindow } from "../src/engine/observed.js";
import { formatSummary, buildSummary } from "../src/engine/summary.js";
import { runValidators } from "../src/engine/validators.js";
import { makeRoot, setStep, validResult, writeIn, writeStatus } from "./helpers.js";

function events(root: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(root, "runs", "execution-log.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Test 36 — a validator that does not run is `skipped`, never `passed`.
// The old shape was `{ passed: true, skipped: true }`, so every consumer that read `passed`
// counted an unexecuted safety net as a success. The tri-state makes that unrepresentable.
//
// diff-scope was the original subject here; it is implemented as of M1.5 第2部, so this now
// targets command-exit-code — the only entry left in NOT_IMPLEMENTED (testing is role: cli,
// out of MVP scope).
test("36: a not-implemented validator reports skipped, not passed", () => {
  const { root, config } = makeRoot();
  setStep(root, "implementation");

  // command-exit-code を宣言していた唯一のステップ(testing)は削除済みなので、
  // NOT_IMPLEMENTED の仕組み自体が生きていることを合成宣言で検証する。
  // validator 型の存廃は M7 で判断する（KI-09）。
  const outcome = runValidators(root, config, [{ type: "command-exit-code", onViolation: "report" }], {
    stepId: "implementation",
    fixAttempts: 0
  });
  const cmd = outcome.results.find((r) => r.type === "command-exit-code");

  assert.ok(cmd, "the NOT_IMPLEMENTED mechanism still produces a result");
  assert.equal(cmd.status, "skipped");
  assert.ok(cmd.skipReason, "a skip must say why it did not run");
  assert.equal(outcome.violations.some((v) => v.type === "command-exit-code"), false);
  assert.equal(outcome.results.filter((r) => r.status === "passed").some((r) => r.type === "command-exit-code"), false);
});

// Test 37 — the skip reaches the Event Log. Before M1.5 only `validation.failed` was recorded,
// so a skipped validator left no trace anywhere.
test("37: validation.completed records every validator status including skips", () => {
  const { root, config } = makeRoot();
  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult);
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });

  assert.equal(runStep(root, config, "implementation").kind, "transitioned");

  const completed = events(root).filter((e) => e.event === "validation.completed");
  assert.equal(completed.length, 1, "one event per validation phase");

  const results = completed[0].results as Array<{ type: string; status: string }>;
  // diff-scope is implemented, but this test sets currentStep directly instead of transitioning
  // into implementation, so no baseline was captured. Missing baseline + onViolation:report =>
  // skipped (design 課題4), which is exactly what must stay visible rather than read as a pass.
  // diff-scope: baseline 未取得 / verify-local: このテスト設定に settings.verifyLocal が無い。
  // どちらも「検査できなかった」であって passed ではない。
  const skipped = results.filter((r) => r.status === "skipped").map((r) => r.type).sort();
  assert.deepEqual(skipped, ["diff-scope", "verify-local"], "uncheckable validators are recorded as skipped");
  assert.deepEqual((completed[0].skipped as string[]).sort(), ["diff-scope", "verify-local"], "and surfaced as a top-level field");
});

// Test 38 — `report` violations and skips ride on the outcome so the CLI can print them.
// Previously the console showed a bare `transitioned:` line and nothing else.
test("38: the pipeline outcome carries report violations and skips", () => {
  const { root, config } = makeRoot();
  setStep(root, "implementation");
  // a current-result.md that breaks its contract: implementation declares it onViolation: report
  writeIn(root, "current-result.md", "# Summary\nonly this heading\n");
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });

  const outcome = runStep(root, config, "implementation");
  assert.equal(outcome.kind, "transitioned", "a report violation must not stop the pipeline");
  const notice = outcome.kind === "transitioned" ? outcome.notice : undefined;

  assert.ok(notice, "the outcome must carry a notice");
  assert.ok(
    notice.reported.some((r) => r.type === "artifact-contract"),
    `expected the report violation, got: ${notice.reported.map((r) => r.type).join(", ")}`
  );
  assert.ok(notice.skipped.some((s) => s.type === "diff-scope"), "and the skipped validator");
});

// Test 39 — Claimed and Observed stay separate. Merging them would hide the signal that matters
// most under unattended operation: the artifacts claiming success while the engine saw otherwise.
test("39: summary keeps Claimed and Observed apart", () => {
  const { root, config } = makeRoot();
  setStep(root, "implementation");
  writeIn(root, "current-result.md", validResult); // claims AC PASS 1 / NOT VERIFIED 1
  writeStatus(root, { step: "implementation", result: "implemented", reason: "x" });
  runStep(root, config, "implementation");

  const text = formatSummary(buildSummary(root), buildObserved(root));
  const claimedAt = text.indexOf("Claimed (from artifacts)");
  const observedAt = text.indexOf("Observed (from event log)");

  assert.ok(claimedAt >= 0 && observedAt > claimedAt, "both sections present, Claimed first");
  assert.match(text.slice(claimedAt, observedAt), /PASS 1 \/ FAIL 0 \/ NOT VERIFIED 1/);
  // the skipped validator appears ONLY in the observed half, and is labelled as not-a-pass
  assert.doesNotMatch(text.slice(claimedAt, observedAt), /diff-scope/);
  assert.match(text.slice(observedAt), /skipped: diff-scope/);
  assert.match(text.slice(observedAt), /成功ではない/);
});

// Test 40 — "unmeasurable" is distinguished per source: missing artifacts and an unreadable event
// log are different reasons for the same `-`, and each half says which applies to it.
test("40: the two halves explain their own unmeasurable state", () => {
  const { root } = makeRoot();

  // `aiw init` creates an EMPTY log, which is readable: 0 events is a fact, not a gap.
  const empty = buildObserved(root);
  assert.deepEqual(empty.validators, [], "an empty log means zero events, not unmeasurable");
  assert.equal(empty.eventsInWindow, 0);
  assert.equal(empty.unavailable, undefined);
  const emptyHalf = formatSummary(buildSummary(root), empty);
  assert.match(emptyHalf.slice(emptyHalf.indexOf("Observed")), /現タスクのイベントがまだ無い/);

  // a genuinely absent log is unmeasurable, and says so in its own terms
  rmSync(path.join(root, "runs", "execution-log.jsonl"));
  const observed = buildObserved(root);
  assert.equal(observed.validators, null);
  assert.equal(observed.unavailable, "no-event-log");

  const text = formatSummary(buildSummary(root), observed);
  const observedHalf = text.slice(text.indexOf("Observed (from event log)"));
  assert.match(observedHalf, /execution-log\.jsonl が未作成/);
  // the artifact-side note must not be reused to explain the event-log side
  assert.doesNotMatch(observedHalf, /research-findings\.md/);
});

// Test 41 — the observed half is scoped to the current task, not the whole history.
// `taskRunId` does not exist in state.json yet, so the window is derived from the log: reflection
// is the only step that ends a task. Replace this with a taskRunId filter once the field lands.
test("41: the observed window starts after the last transition out of reflection", () => {
  const records = [
    { event: "validation.completed", step: "review", results: [] },
    { event: "transition", from: "reflection", to: "task-planning" },
    { event: "validation.completed", step: "task-planning", results: [] },
    { event: "transition", from: "task-planning", to: "research" }
  ];

  const window = currentTaskWindow(records);
  assert.equal(window.length, 2, "only events after the task boundary");
  assert.equal(window[0].step, "task-planning");

  // no reflection transition yet (first task) -> the whole log is the window
  assert.equal(currentTaskWindow(records.slice(2)).length, 2);
  assert.deepEqual(currentTaskWindow([]), []);
});
