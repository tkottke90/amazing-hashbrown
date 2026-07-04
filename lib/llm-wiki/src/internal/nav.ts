/** index.md and log.md manipulation. Pure string transforms. */

import type { LogEntry, PageType } from '../types.js';

/** Index section heading for a page type. */
const TYPE_SECTION: Record<PageType, string> = {
  entity: 'Entities',
  concept: 'Concepts',
  summary: 'Concepts',
  comparison: 'Comparisons',
  query: 'Queries',
  index: 'Concepts',
  log: 'Concepts',
};

export interface IndexEntry {
  type: PageType;
  /** Page path relative to the wiki root, without `.md`. */
  stem: string;
  title: string;
  summary: string;
}

/**
 * Insert (or leave, if already present) a bullet for a page under its section
 * heading. Returns the updated index content.
 */
export function upsertIndexEntry(indexContent: string, entry: IndexEntry): string {
  const bullet = `- [[${entry.stem}|${entry.title}]] — ${entry.summary}`;
  if (indexContent.includes(`[[${entry.stem}|`) || indexContent.includes(`[[${entry.stem}]]`)) {
    return indexContent; // already catalogued
  }

  const section = TYPE_SECTION[entry.type];
  const lines = indexContent.split('\n');
  const headingIdx = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase(),
  );

  if (headingIdx === -1) {
    // No such section — append one at the end.
    return `${indexContent.replace(/\n+$/, '')}\n\n## ${section}\n${bullet}\n`;
  }

  // Insert directly after the section heading.
  lines.splice(headingIdx + 1, 0, bullet);
  return lines.join('\n');
}

/** Update the `> Last updated: ... | Total pages: N` meta line, if present. */
export function setIndexMeta(
  indexContent: string,
  meta: { today: string; totalPages: number },
): string {
  return indexContent.replace(
    /^>\s*Last updated:.*$/m,
    `> Last updated: ${meta.today} | Total pages: ${meta.totalPages}`,
  );
}

/** Format a log heading line: `## [YYYY-MM-DD] action | subject`. */
export function formatLogEntry(opts: {
  today: string;
  action: string;
  subject: string;
  files?: string[];
}): string {
  const heading = `## [${opts.today}] ${opts.action} | ${opts.subject}`;
  if (!opts.files || opts.files.length === 0) return `${heading}\n`;
  const list = opts.files.map((f) => `- ${f}`).join('\n');
  return `${heading}\n${list}\n`;
}

const LOG_HEADING_RE = /^##\s*\[(\d{4}-\d{2}-\d{2})\]\s*([^|]+?)\s*\|\s*(.*)$/;

/** Count the `## [date] action | subject` entries in a log. */
export function countLogEntries(logContent: string): number {
  return logContent.split('\n').filter((l) => LOG_HEADING_RE.test(l)).length;
}

/** Parse the last `n` log entries (most recent last, as written). */
export function parseRecentLog(logContent: string, n: number): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of logContent.split('\n')) {
    const m = LOG_HEADING_RE.exec(line);
    if (m) {
      entries.push({
        date: m[1]!,
        action: m[2]!.trim(),
        subject: m[3]!.trim(),
        raw: line,
      });
    }
  }
  return entries.slice(-n);
}
