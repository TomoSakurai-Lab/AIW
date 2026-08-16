// Markdown section extraction for the M1 review summary. Reads section BODIES, where
// artifactContract.ts only checks that headings exist.
//
// Everything here distinguishes "absent / unreadable" (null) from "present and empty" (0).
// Collapsing those two is the same failure mode as rounding NOT VERIFIED into PASS: a task that
// never produced the section would silently report a clean zero.
import { parseHeadings, parseSectionSpec } from "./artifactContract.js";

// Strip HTML comments. Templates carry `<!-- ... -->` guidance that contains bullet lists, and
// counting those would inflate every count on an untouched artifact.
export function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "");
}

// Body of the section whose heading matches `spec` (level + exact text), up to the next heading
// at the same or shallower level. Returns null when the heading is absent.
export function extractSection(markdown: string, spec: string): string | null {
  const want = parseSectionSpec(spec);
  const headings = parseHeadings(markdown);
  const lines = markdown.split(/\r?\n/);

  const start = headings.find((h) => h.level === want.level && h.text === want.text);
  if (!start) {
    return null;
  }
  const next = headings.find((h) => h.line > start.line && h.level <= start.level);
  return lines.slice(start.line + 1, next ? next.line : lines.length).join("\n");
}

// Count list items at any indent (`- `, `* `, `+ `, `1. `, `1) `). Comment blocks are stripped
// first. A section with prose but no bullets counts as 0 — "書いてあるが箇条書きでない" is
// indistinguishable from "なし" without parsing meaning, and this is a coarse indicator.
export function countListItems(body: string): number {
  return stripHtmlComments(body)
    .split(/\r?\n/)
    .filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)).length;
}

// Count of list items under `spec`, or null when the section is absent.
export function countSectionItems(markdown: string, spec: string): number | null {
  const body = extractSection(markdown, spec);
  return body === null ? null : countListItems(body);
}

export type TriCount = {
  pass: number;
  fail: number;
  notVerified: number;
  /** `Status:` lines whose value is none of the three — a contract violation worth surfacing. */
  unrecognized: number;
};

const STATUS_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?Status(?:\*\*)?\s*[:：]\s*(.+?)\s*$/i;

// Tally `Status: PASS | FAIL | NOT VERIFIED` lines inside a section. Returns null if the section
// is absent. An empty section yields all-zero, which is itself a signal (no AC was reported).
export function countTriStatus(markdown: string, spec: string): TriCount | null {
  const body = extractSection(markdown, spec);
  if (body === null) {
    return null;
  }
  const counts: TriCount = { pass: 0, fail: 0, notVerified: 0, unrecognized: 0 };
  for (const line of stripHtmlComments(body).split(/\r?\n/)) {
    const m = line.match(STATUS_LINE);
    if (!m) {
      continue;
    }
    // tolerate surrounding emphasis/backticks, but NOT a different word
    const value = m[1].replace(/[`*_]/g, "").trim().toUpperCase();
    if (value === "PASS") {
      counts.pass++;
    } else if (value === "FAIL") {
      counts.fail++;
    } else if (value === "NOT VERIFIED" || value === "NOT_VERIFIED") {
      counts.notVerified++;
    } else {
      counts.unrecognized++;
    }
  }
  return counts;
}
