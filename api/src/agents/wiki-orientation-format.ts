import type { LogEntry, OrientResult } from '@tkottke90/llm-wiki';

// Shared by wiki-orient.tool.ts (the agent's own self-triggered path) and
// wiki-orientation-context.middleware.ts (the mechanical, menu-triggered
// path — see docs/superpowers/specs/2026-11-16-chat-wiki-orientation-menu-design.md)
// so both produce byte-identical orientation text instead of two copies
// that can drift apart.

const MAX_INDEX_CHARS = 4000;

// Truncates by whole lines rather than a raw character slice — index.md is a
// line-oriented catalog of one entry per page, and cutting mid-entry would
// leave a dangling, misleading summary instead of one entry cleanly omitted.
function truncateIndex(index: string): string {
  if (index.length <= MAX_INDEX_CHARS) return index;
  const lines = index.split('\n');
  let out = '';
  let cutAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const next = `${out}${lines[i]}\n`;
    if (next.length > MAX_INDEX_CHARS) {
      cutAt = i;
      break;
    }
    out = next;
  }
  const omitted = lines.length - cutAt;
  return omitted > 0
    ? `${out}\n[index truncated — ${omitted} more entries omitted; use wiki_search for details]`
    : out;
}

export function formatWikiOrientation(wikiId: string, result: OrientResult): string {
  const { schema, index, recentLog } = result;
  const logLines = recentLog.length
    ? recentLog.map((e: LogEntry) => `- [${e.date}] ${e.action} | ${e.subject}`).join('\n')
    : '(no log entries yet)';

  return [
    `# Wiki Orientation: ${wikiId}`,
    '',
    '## Schema',
    schema || '(empty)',
    '',
    '## Index',
    truncateIndex(index) || '(empty)',
    '',
    '## Recent Log',
    logLines,
  ].join('\n');
}
