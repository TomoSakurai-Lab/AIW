import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initRoot, loadConfig } from "../src/engine/engine.js";
import { updateState } from "../src/engine/state.js";
import type { WorkflowConfig } from "../src/engine/types.js";

// 実配置を再現する: 検査対象リポジトリ（git repo）の中にランタイムルートがあり、
// ランタイムルートは gitignore されている。diff-scope は runtimeRoot の親から
// `git rev-parse --show-toplevel` で検査対象を解決するので、この形でないと
// テストと本番で検査の効き方が変わってしまう。
export function makeRoot(): { root: string; config: WorkflowConfig; repoRoot: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "aiw-test-"));
  const g = (...args: string[]): void => {
    execFileSync("git", ["-C", repoRoot, ...args], { windowsHide: true, stdio: "ignore" });
  };
  g("init", "-q", ".");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  writeFileSync(path.join(repoRoot, ".gitignore"), [".ai-workflow2/", ""].join("\n"), "utf8");
  g("add", "-A");
  g("commit", "-qm", "init");

  const root = path.join(repoRoot, ".ai-workflow2");
  initRoot(root);
  return { root, config: loadConfig(root), repoRoot };
}

export function writeIn(root: string, rel: string, content: string): void {
  writeFileSync(path.join(root, rel), content, "utf8");
}

export function writeStatus(root: string, status: Record<string, unknown>): void {
  writeFileSync(path.join(root, "current-status.json"), JSON.stringify(status, null, 2), "utf8");
}

export function setStep(root: string, currentStep: string, patch: Record<string, unknown> = {}): void {
  updateState(root, {
    currentStep,
    status: "ready",
    haltedReason: null,
    pendingApproval: null,
    pendingTransition: null,
    ...patch
  });
}

// A feature.md carrying a "Phase list" section (M1 fixture). First phase is the Current phase.
export function validFeature(phases: string[]): string {
  const items = phases.map((p) => `- ${p}`).join("\n");
  return `# Feature

## Phase list
${items}

Current phase: ${phases[0] ?? ""}
`;
}

// Overwrite current-status.json with a status that would FAIL re-validation (result is not a
// transition key). Used to prove resume skips validations 2–5 on the checkpoint path.
export function corruptStatus(root: string): void {
  writeFileSync(
    path.join(root, "current-status.json"),
    JSON.stringify({ step: "reflection", result: "not-a-transition", reason: "corrupt" }, null, 2),
    "utf8"
  );
}

// ---- valid artifact fixtures (satisfy §7.4 contracts) ----

export const validTask = `# Task

Task ID: TASK-001

## Goal
g
## Scope
s
## Requirements
r
## Out of Scope
o
## Acceptance Criteria
a
`;

// M1: current-result.md is a verification package (11 sections, three-valued AC status).
export const validResult = `# Summary
s
## Change Map
cm
## Files Changed
f
## Acceptance Criteria Verification
### AC-01
Status: PASS
Evidence:
- unit test "renders"
### AC-02
Status: NOT VERIFIED
Notes:
- 環境がないため未検証
## Automated Evidence
ae
## Manual Verification Required
- 画面で目視確認
## Unresolved Decisions
ud
## Risk Areas
- 共通コンポーネントを変更した
## Tests Run
t
## Test Results
tr
## Deviations
d
`;

// reflection が書く task-metadata.json（M1: file-exists validator の対象）。
export const validTaskMetadata = JSON.stringify(
  {
    featureId: null,
    featureName: null,
    phaseId: null,
    phaseName: null,
    taskName: "sample-task",
    summary: "サンプル",
    tags: ["refactor"],
    metrics: {
      acceptanceCriteria: { pass: 1, fail: 0, notVerified: 1 },
      openDecisions: 0,
      manualVerificationRequired: 1,
      highRiskChanges: 0
    }
  },
  null,
  2
);

// reflection を通すのに必要な成果物を置く（M1 で file-exists の対象が増えた）。
export function seedReflectionOutputs(root: string): void {
  writeIn(root, "task-metadata.json", validTaskMetadata);
}

// archive/<feature>/ 配下のタスクディレクトリ（新しい順）。退避先は
// <timestamp>-<taskId> で一意になるため、テストは名前を決め打ちせずここから引く。
export function archivedTaskDirs(root: string, feature = "single"): string[] {
  const dir = path.join(path.resolve(root), "archive", feature);
  return existsSync(dir) ? readdirSync(dir).sort().reverse() : [];
}

// M1: research-findings.md — 人間とレビュアー向け。token-range 制約なし。
export const validResearchFindings = `# Current Behavior
c
# Target Behavior
t
# Delta
d
# Uncertain Delta
u
# Inferred Behavior
- minWidth は 160px
  - 算出根拠: root幅 200 − input幅 28 − input padding 12
  - 確度: 中
# Open Decisions
- 空状態の文言を決める
- エラー表示をトーストにするか
# UX Assumptions
ua
# Risk Areas
ra
`;

// ~1000 estimated tokens (in [500,1500]) with all required sections.
export function validContextPackage(): string {
  const filler = "lorem ipsum dolor sit amet ".repeat(150).trim();
  return `# Task Summary
${filler}

# Source Requirements
r

# Constraints
c

# Files

## Read
x
## Modify
y
## Reference
z
## Ignore
w

# Acceptance Criteria Matrix

| ID | Expected Behavior | Verification | Evidence Required |
|---|---|---|---|
| AC-01 | a | unit test | test name |
| AC-02 | b | manual | screenshot |

# Test Strategy
ts
`;
}

export const validCodexPrompt = `# Objective
o
# Required Changes
rc
# Scope Boundaries
sb
# Acceptance Criteria
ac
# Required Tests
rt
`;

export const validReview = `# Summary
s
## Specification Coverage Audit
- Source Requirements を全て満たす
## Acceptance Criteria Evidence Audit
- AC-01 の Evidence は実在
## Manual Verification Audit
- 漏れなし
## Risk Area Audit
- Inferred の算出根拠を検算済み
## Critical
c
## Major
m
## Minor
mi
## Good
g
## Backlog
b
## Ready
r
## Verification Data
v
## Fix Scope
### Files To Modify
f
### Critical
c
### Major
m
### Acceptance Criteria
a
### Test Required
t
`;

// current-review.md missing the INNER "### Critical" (Fix Scope), but keeping "## Critical".
export const reviewMissingInnerCritical = `# Summary
s
## Specification Coverage Audit
a
## Acceptance Criteria Evidence Audit
a
## Manual Verification Audit
a
## Risk Area Audit
a
## Critical
c
## Major
m
## Minor
mi
## Good
g
## Backlog
b
## Ready
r
## Verification Data
v
## Fix Scope
### Files To Modify
f
### Major
m
### Acceptance Criteria
a
### Test Required
t
`;
