// `aiw status --summary` — the M1 confirmation summary (計画 M1.4).
//
// Aggregates the four things a human needs before approving, from the artifacts themselves:
//
//   Open Decisions / Manual Verification Required / High Risk Changes / AC の PASS・FAIL・NOT VERIFIED
//
// Every field is `number | null`. **null means "the section does not exist", not "zero".**
// A task whose research never produced `# Open Decisions` must not read as "0 open decisions".
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildObserved, countByStatus, type Observed } from "./observed.js";
import { countSectionItems, countTriStatus, type TriCount } from "./sections.js";

export type ReviewSummary = {
  /** research-findings.md `# Open Decisions` */
  openDecisions: number | null;
  /** current-result.md `## Manual Verification Required` */
  manualVerificationRequired: number | null;
  /** current-result.md `## Risk Areas` */
  highRiskChanges: number | null;
  /** current-result.md `## Unresolved Decisions` — 実装が独断で決めた事項 */
  unresolvedDecisions: number | null;
  /** current-result.md `## Acceptance Criteria Verification` */
  acceptanceCriteria: TriCount | null;
  /** which source artifacts were readable (null fields are explained by these) */
  sources: { researchFindings: boolean; currentResult: boolean };
};

function readIfExists(root: string, file: string): string | null {
  const p = path.join(path.resolve(root), file);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function buildSummary(root: string): ReviewSummary {
  const findings = readIfExists(root, "research-findings.md");
  const result = readIfExists(root, "current-result.md");

  return {
    openDecisions: findings === null ? null : countSectionItems(findings, "# Open Decisions"),
    manualVerificationRequired:
      result === null ? null : countSectionItems(result, "## Manual Verification Required"),
    highRiskChanges: result === null ? null : countSectionItems(result, "## Risk Areas"),
    unresolvedDecisions: result === null ? null : countSectionItems(result, "## Unresolved Decisions"),
    acceptanceCriteria: result === null ? null : countTriStatus(result, "## Acceptance Criteria Verification"),
    sources: { researchFindings: findings !== null, currentResult: result !== null }
  };
}

// Human-readable rendering, split by SOURCE.
//
//   Claimed  — what the AI wrote in its artifacts (self-reported)
//   Observed — what the engine verified, from the Event Log
//
// The two are never merged. Under unattended operation the most important signal is a
// DISAGREEMENT between them ("all ACs PASS" + "diff-scope reported a violation"), and that signal
// only exists while the halves stay separate. `-` means unmeasurable in both, but the reason
// differs per half, so each prints its own note.
export function formatSummary(summary: ReviewSummary, observed?: Observed): string {
  const n = (v: number | null): string => (v === null ? "-" : String(v));
  const ac = summary.acceptanceCriteria;
  const lines = [
    "Claimed (from artifacts)",
    ac === null
      ? "  Acceptance Criteria:  -"
      : `  Acceptance Criteria:  PASS ${ac.pass} / FAIL ${ac.fail} / NOT VERIFIED ${ac.notVerified}` +
        (ac.unrecognized > 0 ? `  (未認識の Status: ${ac.unrecognized})` : ""),
    `  Open Decisions:       ${n(summary.openDecisions)}`,
    `  Manual Verification:  ${n(summary.manualVerificationRequired)}`,
    `  High Risk Changes:    ${n(summary.highRiskChanges)}`,
    `  Unresolved Decisions: ${n(summary.unresolvedDecisions)}`
  ];

  const hasNull =
    summary.openDecisions === null ||
    summary.manualVerificationRequired === null ||
    summary.highRiskChanges === null ||
    summary.unresolvedDecisions === null ||
    ac === null;

  if (hasNull) {
    const missing: string[] = [];
    if (!summary.sources.researchFindings) {
      missing.push("research-findings.md");
    }
    if (!summary.sources.currentResult) {
      missing.push("current-result.md");
    }
    lines.push('  ※ "-" は計測不能（0件ではない）。');
    if (missing.length > 0) {
      lines.push(`     未作成: ${missing.join(", ")}`);
    }
    // A file can exist yet predate the M1 contract, so both reasons can apply at once.
    lines.push("     成果物に該当セクションが無い場合も同じく「-」になる。");
  }
  if (ac && ac.unrecognized > 0) {
    lines.push("  ※ Status は PASS / FAIL / NOT VERIFIED の三値のみ。上記は未認識の値。");
  }

  if (observed) {
    lines.push("");
    lines.push("Observed (from event log)");
    if (observed.validators === null) {
      lines.push("  Validators:           -");
      lines.push("  fixAttempts:          -");
      lines.push(
        observed.unavailable === "no-event-log"
          ? '  ※ "-" は計測不能。runs/execution-log.jsonl が未作成（まだ1ステップも実行していない）。'
          : '  ※ "-" は計測不能。runs/execution-log.jsonl を読めなかった。'
      );
    } else {
      const c = countByStatus(observed.validators);
      lines.push(`  Validators:           passed ${c.passed} / failed ${c.failed} / skipped ${c.skipped}`);
      for (const v of observed.validators.filter((x) => x.status === "skipped")) {
        lines.push(`    skipped: ${v.type} — ${v.skipReason ?? "did not run"}（成功ではない）`);
      }
      for (const r of observed.reported ?? []) {
        lines.push(`    report:  ${r.validator} — ${r.message}`);
      }
      lines.push(`  fixAttempts:          ${observed.fixAttempts === null ? "-" : observed.fixAttempts}`);
      if (observed.eventsInWindow === 0) {
        lines.push("  ※ 現タスクのイベントがまだ無い（直前のタスク境界以降が対象）。");
      }
    }
  }
  return lines.join("\n");
}
