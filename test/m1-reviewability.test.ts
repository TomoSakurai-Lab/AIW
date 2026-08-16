import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { nextSuggestion, runStep } from "../src/engine/engine.js";
import { countSectionItems, countTriStatus, extractSection } from "../src/engine/sections.js";
import { estimateTokens } from "../src/engine/tokens.js";
import { buildSummary, formatSummary } from "../src/engine/summary.js";
import { versionInfo } from "../src/engine/versions.js";
import { runValidators } from "../src/engine/validators.js";
import {
  makeRoot,
  setStep,
  validCodexPrompt,
  validContextPackage,
  validResearchFindings,
  validResult,
  validReview,
  writeIn,
  writeStatus
} from "./helpers.js";

// Test 27 — research now produces research-findings.md, and its contract is enforced.
test("27: research requires research-findings.md and enforces its contract", () => {
  const { root, config } = makeRoot();
  setStep(root, "research");
  writeIn(root, "context-package.md", validContextPackage());
  writeIn(root, "codex-prompt.md", validCodexPrompt);
  writeStatus(root, { step: "research", result: "research-complete", reason: "x" });

  // missing entirely -> file-exists halts
  const missing = runValidators(root, config, config.steps["research"].validators!);
  assert.equal(missing.halt, true);
  assert.ok(missing.violations.some((v) => v.message.includes("research-findings.md")));

  // present but missing a section -> artifact-contract halts
  writeIn(root, "research-findings.md", "# Current Behavior\nc\n# Target Behavior\nt\n");
  const partial = runValidators(root, config, config.steps["research"].validators!);
  assert.equal(partial.halt, true);
  assert.ok(partial.violations.some((v) => v.message.includes("# Open Decisions")));

  // complete -> passes, and context-package stays inside token-range
  writeIn(root, "research-findings.md", validResearchFindings);
  const ok = runValidators(root, config, config.steps["research"].validators!);
  assert.equal(ok.halt, false, ok.violations.map((v) => v.message).join(" / "));
});

// Test 28 — a realistic context-package stays inside the configured token-range.
test("28: context-package with the M1 sections still fits token-range", () => {
  const { root, config } = makeRoot();
  setStep(root, "research");
  writeIn(root, "context-package.md", validContextPackage());
  writeIn(root, "codex-prompt.md", validCodexPrompt);
  writeIn(root, "research-findings.md", validResearchFindings);
  writeStatus(root, { step: "research", result: "research-complete", reason: "x" });

  const outcome = runValidators(root, config, config.steps["research"].validators!);
  const tokenViolation = outcome.violations.find((v) => v.type === "token-range");
  assert.equal(tokenViolation, undefined, `token-range violated: ${tokenViolation?.message}`);
});

// A context-package that satisfies the contract (all headings, in order) but carries no content.
const SKELETON_PACKAGE = [
  "# Task Summary",
  "# Source Requirements",
  "# Constraints",
  "# Files",
  "## Read",
  "## Modify",
  "## Reference",
  "## Ignore",
  "# Acceptance Criteria Matrix",
  "# Test Strategy"
].join("\n\n");

// The smallest package a real (tiny) task would produce: one AC, one file to modify.
const MINIMAL_PACKAGE = `# Task Summary
セレクタの選択後にリストが1件へ絞られる不具合を直す。対象は FuzzySelect のみで、
IME 変換中の挙動は現状を維持する。

# Source Requirements
- 選択済みの状態で再度開いたとき候補が絞られないこと

# Constraints
- 既存の公開 API を変えない

# Files

## Read
- src/components/common/FuzzySelect.tsx
## Modify
- src/components/common/FuzzySelect.tsx
## Reference
- docs/現状仕様.md
## Ignore
- .ai-workflow2/ 配下すべて（context-package.md / codex-prompt.md / research-findings.md /
  current-task.md / current-review.md / state.json）

# Acceptance Criteria Matrix

| ID | Expected Behavior | Verification | Evidence Required |
|---|---|---|---|
| AC-01 | 選択後もリスト全件が表示される | component test | テスト名 |

# Test Strategy
- build / unit test
`;

// Test 28b — the lower bound's role changed in M1: it no longer measures "is there enough
// information" (that moved to research-findings.md); it detects a stub or an empty skeleton.
//
// The floor must sit strictly between the skeleton and a realistic package. The exact value is
// config, so this asserts the ordering rather than a number — a re-tuned floor keeps passing as
// long as it still separates those two.
//
// MEASURED (estimateTokens): skeleton 118 / terse minimal 163 / fixture ~1000.
// NOTE: a *terse* real package for a tiny task measures 163, i.e. BELOW the configured floor of
// 250. Such a task halts. See docs/aiw-known-issues.md KI-03.
test("28b: token-range floor separates a skeleton from a realistic package", () => {
  const { root, config } = makeRoot();
  setStep(root, "research");
  writeIn(root, "codex-prompt.md", validCodexPrompt);
  writeIn(root, "research-findings.md", validResearchFindings);
  writeStatus(root, { step: "research", result: "research-complete", reason: "x" });
  const validators = config.steps["research"].validators!;

  const range = validators.find((v) => v.type === "token-range")!;
  assert.equal(range.onViolation, "halt", "the floor must halt, not report (report is silent on the console)");
  assert.ok(range.min !== undefined && range.min > estimateTokens(SKELETON_PACKAGE), "floor must reject the skeleton");
  assert.ok(range.max === 1500, "the ceiling protects Codex's focus and is not relaxed");

  // skeleton: passes artifact-contract (headings are all there) but must be caught by token-range
  writeIn(root, "context-package.md", SKELETON_PACKAGE);
  const skeleton = runValidators(root, config, validators);
  assert.equal(skeleton.halt, true, "an empty skeleton must halt");
  const violation = skeleton.violations.find((v) => v.type === "token-range");
  assert.ok(violation, `expected a token-range violation, got: ${skeleton.violations.map((v) => v.type).join(", ")}`);

  // a realistic package must get through
  writeIn(root, "context-package.md", validContextPackage());
  const realistic = runValidators(root, config, validators);
  assert.equal(realistic.halt, false, realistic.violations.map((v) => v.message).join(" / "));

  // documents the boundary risk: a terse package for a tiny task is below the floor today
  assert.ok(
    estimateTokens(MINIMAL_PACKAGE) < (range.min ?? 0),
    "if this fails the floor was lowered past the terse-minimal case; update KI-03"
  );
});

// Test 29 — ux-decision-required is a declared transition that re-enters research.
test("29: ux-decision-required returns to research without halting", () => {
  const { root, config } = makeRoot();
  assert.deepEqual(Object.keys(config.steps["research"].transitions).sort(), [
    "research-complete",
    "ux-decision-required"
  ]);

  setStep(root, "research");
  writeIn(root, "context-package.md", validContextPackage());
  writeIn(root, "codex-prompt.md", validCodexPrompt);
  writeIn(root, "research-findings.md", validResearchFindings);
  writeStatus(root, { step: "research", result: "ux-decision-required", reason: "空状態の文言が未確定" });

  // research has an approval gate, so the pipeline parks here first
  assert.equal(runStep(root, config, "research").kind, "awaiting-approval");
});

// Test 30 — section extraction distinguishes "absent" from "empty", and ignores HTML comments.
test("30: sections treat a missing section as null, not zero", () => {
  const doc = [
    "# Open Decisions",
    "<!--",
    "- これはテンプレートのコメントなので数えない",
    "-->",
    "- 決めること1",
    "- 決めること2",
    "",
    "# Risk Areas",
    ""
  ].join("\n");

  assert.equal(countSectionItems(doc, "# Open Decisions"), 2, "comment bullets must not be counted");
  assert.equal(countSectionItems(doc, "# Risk Areas"), 0, "present but empty is zero");
  assert.equal(countSectionItems(doc, "# Nope"), null, "absent is null, never zero");
  assert.equal(extractSection(doc, "# Nope"), null);
});

// Test 31 — the three-valued AC tally, including values that are none of the three.
test("31: AC status tally keeps NOT VERIFIED separate and flags unknown values", () => {
  const doc = [
    "## Acceptance Criteria Verification",
    "### AC-01",
    "Status: PASS",
    "### AC-02",
    "Status: NOT VERIFIED",
    "### AC-03",
    "Status: **FAIL**",
    "### AC-04",
    "Status: approved",
    "## Next"
  ].join("\n");

  const tri = countTriStatus(doc, "## Acceptance Criteria Verification");
  assert.deepEqual(tri, { pass: 1, fail: 1, notVerified: 1, unrecognized: 1 });
  assert.equal(countTriStatus(doc, "## Missing Section"), null);
});

// Test 32 — the summary reports unmeasurable fields as null and renders them as "-".
test("32: status summary distinguishes unmeasurable from zero", () => {
  const { root } = makeRoot();

  // nothing produced yet: current-result.md exists (init seeds it from the template) but
  // research-findings.md does not.
  rmSync(path.join(root, "research-findings.md"), { force: true });
  const empty = buildSummary(root);
  assert.equal(empty.openDecisions, null, "no research-findings.md -> unmeasurable");
  assert.equal(empty.sources.researchFindings, false);
  assert.match(formatSummary(empty), /Open Decisions: +-/);
  assert.match(formatSummary(empty), /^Claimed \(from artifacts\)/m);
  assert.match(formatSummary(empty), /計測不能/);

  // the seeded template has the AC section but no Status lines yet -> all zero, not null
  assert.deepEqual(empty.acceptanceCriteria, { pass: 0, fail: 0, notVerified: 0, unrecognized: 0 });

  writeIn(root, "research-findings.md", validResearchFindings);
  writeIn(root, "current-result.md", validResult);
  const full = buildSummary(root);
  assert.equal(full.openDecisions, 2);
  assert.equal(full.manualVerificationRequired, 1);
  assert.equal(full.highRiskChanges, 1);
  assert.deepEqual(full.acceptanceCriteria, { pass: 1, fail: 0, notVerified: 1, unrecognized: 0 });

  const text = formatSummary(full);
  assert.match(text, /PASS 1 \/ FAIL 0 \/ NOT VERIFIED 1/);
  assert.doesNotMatch(text, /計測不能/);
});

// Test 33 — implementation / fix prompts are now recorded in the Event Log (they were null).
test("33: versionInfo records implementation and fix prompt versions", () => {
  const { root, config } = makeRoot();

  for (const step of ["implementation", "fix", "research", "review"]) {
    const v = versionInfo(root, config, step);
    assert.ok(v.promptVersion !== null, `${step}: promptVersion must be recorded`);
    assert.ok(v.promptHash !== null, `${step}: promptHash must be recorded`);
  }

  // research's template is research-findings.md (M1)
  const research = versionInfo(root, config, "research");
  assert.equal(research.templateVersion, config.versions?.templates?.researchFindings);
  assert.ok(research.templateHash !== null);
});

// Test 34 — `aiw next` resolves the terminal state instead of calling it unknown.
test("34: next suggests new-task at the terminal state", () => {
  const { root, config } = makeRoot();

  setStep(root, "complete");
  const done = nextSuggestion(root, config);
  assert.equal(done.action, "aiw new-task");
  assert.match(done.reason, /terminal state "complete"/);

  // a genuinely unknown state is still reported as unknown
  setStep(root, "not-a-state");
  assert.equal(nextSuggestion(root, config).action, "aiw status");
});

// Test 35 — an invalid `result` halt carries the allowed values so the CLI can print them.
test("35: invalid result halt exposes the allowed transition keys", () => {
  const { root, config } = makeRoot();
  setStep(root, "review");
  writeIn(root, "current-review.md", validReview);
  writeStatus(root, { step: "review", result: "approved", reason: "承認ゲートと混同した" });

  const out = runStep(root, config, "review");
  assert.equal(out.kind, "halted");
  assert.equal(out.kind === "halted" && out.reason, "invalid-status");
  const allowed = out.kind === "halted" ? (out.detail?.allowed as string[]) : [];
  assert.deepEqual([...allowed].sort(), ["fix-required", "ready"]);
});
