// Artifact Contract matcher (§7.4): `sections` is an ORDERED SUBSEQUENCE of the document's
// headings, matched on (level, exact text). This distinguishes `## Critical` from `### Critical`.

export type Heading = { level: number; text: string; line: number };

// Parse ATX headings, skipping fenced code blocks so ``` ## x ``` isn't treated as a heading.
// `line` is the 0-based index of the heading, used by sections.ts to slice out section bodies.
export function parseHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let inFence = false;
  let fenceMarker = "";
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const marker = fence[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) {
      continue;
    }
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim(), line: i });
    }
  }
  return headings;
}

// A section spec like "### Critical" -> { level: 3, text: "Critical" }. `line` is not meaningful
// for a spec; it is -1 so the shape stays compatible with Heading.
export function parseSectionSpec(spec: string): Heading {
  const m = spec.match(/^(#{1,6})\s+(.*)$/);
  if (!m) {
    throw new Error(`Invalid section spec "${spec}" (expected e.g. "## Critical").`);
  }
  return { level: m[1].length, text: m[2].trim(), line: -1 };
}

export type ContractResult = { ok: boolean; missing: string[] };

export function checkMarkdownSections(markdown: string, sections: string[]): ContractResult {
  const headings = parseHeadings(markdown);
  const required = sections.map((s) => ({ spec: s, want: parseSectionSpec(s) }));

  let pointer = 0;
  for (const h of headings) {
    if (pointer >= required.length) {
      break;
    }
    const want = required[pointer].want;
    if (h.level === want.level && h.text === want.text) {
      pointer += 1;
    }
  }

  const missing = required.slice(pointer).map((r) => r.spec);
  return { ok: missing.length === 0, missing };
}
