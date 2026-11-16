// Pure parsing logic for the harness-docs build-time corpus generator
// (build-harness-docs-index.ts). No filesystem or LlmWiki I/O here — every
// function takes raw markdown text in and returns plain data out, so the
// parsing rules themselves are unit-testable without spinning up a wiki.
//
// See docs/superpowers/specs/2026-11-13-harness-docs-tool-corpus-design.md
// for why this content (GLOSSARY.md + docs/App-Docs) and this shape (one
// page per term / per heading) were chosen.

import type { PageInput } from '@tkottke90/llm-wiki';

/** Kept small on purpose: this corpus returns capped excerpts, not full-page
 * dumps (api/src/agents/tools/search-harness-docs.tool.ts caps the combined
 * response at 8,000 chars). A page much larger than this would dominate a
 * single search result on its own. */
export const MAX_PAGE_CHARS = 3000;

export interface ParsedPage {
  title: string;
  tags: string[];
  sources: string[];
  body: string;
}

function toPageInput(page: ParsedPage): PageInput {
  return {
    type: 'concept',
    title: page.title,
    tags: page.tags,
    sources: page.sources,
    body: page.body,
  };
}

// ---------------------------------------------------------------------------
// GLOSSARY.md — one page per bolded term entry.
// ---------------------------------------------------------------------------

// A term-entry start line: one or more "**Term**" spans joined by " / ",
// ending the line with a bare colon — e.g. "**Widget**:" or
// "**Archive** / **Unarchive**:". Matched on the whole line so a bolded
// phrase used *within* a definition paragraph is never mistaken for a new
// entry starting.
const TERM_LINE = /^((?:\*\*[^*]+\*\*)(?:\s*\/\s*\*\*[^*]+\*\*)*):$/;
const TOP_HEADING = /^# (.+)$/;
const ANY_HEADING = /^#{1,6}\s+.+$/;

function termTitle(line: string): string {
  const match = TERM_LINE.exec(line);
  // match[1] is the regex's only capturing group — it always participates
  // when TERM_LINE matches at all, so this is safe despite the group's
  // nominal `string | undefined` type.
  const inner = match ? match[1]! : line.replace(/:$/, '');
  return inner
    .split('/')
    .map((part) => part.trim().replace(/^\*\*|\*\*$/g, ''))
    .join(' / ');
}

/** Parses GLOSSARY.md's repeating "**Term**:\n<definition>\n_Avoid_: ..."
 * shape into one page per term, tagged with its enclosing top-level `#`
 * section (e.g. "Dashboard Widgets"). */
export function parseGlossary(markdown: string, sourceFile = 'GLOSSARY.md'): PageInput[] {
  const lines = markdown.split('\n');
  const pages: ParsedPage[] = [];
  let currentSection = '';
  let i = 0;

  while (i < lines.length) {
    // Safe: the while condition above guarantees index i is in bounds.
    const line = lines[i]!;
    const topHeading = TOP_HEADING.exec(line);
    if (topHeading) {
      currentSection = topHeading[1]!.trim();
      i += 1;
      continue;
    }

    if (TERM_LINE.test(line)) {
      const title = termTitle(line);
      const bodyLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bodyLine = lines[j]!;
        if (TERM_LINE.test(bodyLine) || ANY_HEADING.test(bodyLine)) break;
        bodyLines.push(bodyLine);
        j += 1;
      }
      const body = bodyLines.join('\n').trim();
      pages.push({
        title,
        tags: currentSection ? [currentSection] : [],
        sources: [`${sourceFile}#${slugAnchor(title)}`],
        body,
      });
      i = j;
      continue;
    }

    i += 1;
  }

  return pages.map(toPageInput);
}

// ---------------------------------------------------------------------------
// docs/App-Docs/*.md — one page per heading, fence-aware.
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.+)$/;
const FENCE = /^```/;

interface RawSection {
  title: string;
  body: string;
}

/** Splits a markdown file into one section per heading, treating any line
 * inside a fenced code block as plain content even if it starts with `#`
 * (a bash comment, not a Markdown heading) — docs/App-Docs/Evaluations.md
 * has several such lines inside its example command blocks. */
function splitByHeading(markdown: string): RawSection[] {
  const lines = markdown.split('\n');
  const sections: RawSection[] = [];
  let title: string | null = null;
  let body: string[] = [];
  let inFence = false;

  const flush = () => {
    if (title !== null) sections.push({ title, body: body.join('\n').trim() });
  };

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;

    const heading = !inFence ? HEADING.exec(line) : null;
    if (heading) {
      flush();
      // heading[2] is HEADING's second capturing group — always present
      // when the regex matches at all.
      title = cleanHeadingTitle(heading[2]!);
      body = [];
      continue;
    }

    if (title !== null) body.push(line);
  }
  flush();

  return sections;
}

function cleanHeadingTitle(raw: string): string {
  const trimmed = raw.trim();
  const backtickWrapped = /^`([^`]+)`$/.exec(trimmed);
  return backtickWrapped ? backtickWrapped[1]! : trimmed;
}

function slugAnchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parses one docs/App-Docs file into one page per heading section,
 * recursively splitting any section whose body exceeds MAX_PAGE_CHARS. */
export function parseAppDoc(filename: string, markdown: string): PageInput[] {
  const tag = filename.replace(/\.md$/i, '');
  const sections = splitByHeading(markdown);
  const pages: ParsedPage[] = [];

  for (const section of sections) {
    if (section.body.length <= MAX_PAGE_CHARS) {
      pages.push({
        title: section.title,
        tags: [tag],
        sources: [`${filename}#${slugAnchor(section.title)}`],
        body: section.body,
      });
      continue;
    }

    const parts = splitOversizedBody(section.body);
    parts.forEach((part, index) => {
      pages.push({
        title: `${section.title} (part ${index + 1})`,
        tags: [tag],
        sources: [`${filename}#${slugAnchor(section.title)}`],
        body: part,
      });
    });
  }

  return pages.map(toPageInput);
}

// ---------------------------------------------------------------------------
// Oversized-section splitting: batch by table rows, then list items, then
// paragraphs — whichever structure the content actually has — accumulating
// each batch up to MAX_PAGE_CHARS rather than one flat character slice.
// ---------------------------------------------------------------------------

const TABLE_ROW = /^\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\|[\s:|-]+\|\s*$/;
const LIST_ITEM_START = /^(\s*)([-*]|\d+\.)\s+/;

type Block =
  | { kind: 'table'; header: string; separator: string; rows: string[] }
  | { kind: 'text'; lines: string[] };

/** Groups body lines into table blocks (contiguous `| ... |` rows with a
 * header + separator) and plain-text blocks (everything else), preserving
 * order. A plain-text block may itself be prose or a list — batched
 * identically below, since both are "accumulate lines until budget." */
function toBlocks(body: string): Block[] {
  const lines = body.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  // Safe: every index used below (i, i+1, j) is only ever read once its own
  // loop condition has confirmed it's within `lines.length`.
  const isTableStart = (at: number): boolean =>
    at + 1 < lines.length && TABLE_ROW.test(lines[at]!) && TABLE_SEPARATOR.test(lines[at + 1]!);

  while (i < lines.length) {
    if (isTableStart(i)) {
      const header = lines[i]!;
      const separator = lines[i + 1]!;
      const rows: string[] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j]!)) {
        rows.push(lines[j]!);
        j += 1;
      }
      blocks.push({ kind: 'table', header, separator, rows });
      i = j;
      continue;
    }

    const textLines: string[] = [];
    while (i < lines.length && !isTableStart(i)) {
      textLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: 'text', lines: textLines });
  }

  return blocks;
}

function tableRowBatches(block: Block & { kind: 'table' }): string[] {
  const prefix = `${block.header}\n${block.separator}\n`;
  if (prefix.length >= MAX_PAGE_CHARS || block.rows.length === 0) {
    return [`${prefix}${block.rows.join('\n')}`.trim()];
  }

  const batches: string[] = [];
  let current = prefix;
  for (const row of block.rows) {
    const next = `${current}${row}\n`;
    if (next.length > MAX_PAGE_CHARS && current !== prefix) {
      batches.push(current.trim());
      current = `${prefix}${row}\n`;
    } else {
      current = next;
    }
  }
  if (current.trim().length > 0) batches.push(current.trim());
  return batches;
}

/** Splits a run of plain-text lines on list-item or paragraph boundaries
 * (whichever applies), batching units up to MAX_PAGE_CHARS — the same
 * accumulate-until-budget shape as wiki-orient.tool.ts's truncateIndex(),
 * generating multiple pages instead of truncating to one. */
function textBatches(lines: string[]): string[] {
  const units: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) units.push(current.join('\n'));
    current = [];
  };

  for (const line of lines) {
    const isNewListItem = LIST_ITEM_START.test(line);
    const isBlank = line.trim() === '';
    if ((isNewListItem || isBlank) && current.length > 0) flush();
    if (!isBlank) current.push(line);
  }
  flush();

  const batches: string[] = [];
  let batch = '';
  for (const unit of units) {
    const next = batch ? `${batch}\n\n${unit}` : unit;
    if (next.length > MAX_PAGE_CHARS && batch) {
      batches.push(batch);
      batch = unit;
    } else {
      batch = next;
    }
  }
  if (batch) batches.push(batch);
  return batches;
}

function splitOversizedBody(body: string): string[] {
  const blocks = toBlocks(body);
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.kind === 'table') {
      parts.push(...tableRowBatches(block));
    } else {
      const trimmed = block.lines.join('\n').trim();
      if (trimmed.length === 0) continue;
      if (trimmed.length <= MAX_PAGE_CHARS) {
        parts.push(trimmed);
      } else {
        parts.push(...textBatches(block.lines));
      }
    }
  }

  // Merge adjacent small parts so a run of many tiny list-item batches
  // doesn't become one page per item; re-batch the already-split parts up
  // to budget one more time.
  const merged: string[] = [];
  let current = '';
  for (const part of parts) {
    const next = current ? `${current}\n\n${part}` : part;
    if (next.length > MAX_PAGE_CHARS && current) {
      merged.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) merged.push(current);

  return merged.length > 0 ? merged : [body];
}
