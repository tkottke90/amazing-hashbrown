import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWikiRegistry } from '../../services/wiki.js';
import { getActiveSseWriter } from '../active-sse-writer.js';

const WikiOrientSchema = z.object({
  wikiId: z
    .string()
    .describe(
      'Wiki domain ID to orient on (e.g. "user"), as returned by wiki_locate or wiki_search.',
    ),
});

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

export const wikiOrientTool = tool(
  async ({ wikiId }, config) => {
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      return 'Wiki knowledge base is not available.';
    }

    let wiki;
    try {
      wiki = await registry.load(wikiId);
    } catch {
      return `Wiki "${wikiId}" is not registered. Use wiki_locate to find available domains.`;
    }

    const { schema, index, recentLog } = await wiki.orient();

    const threadId = config?.configurable?.thread_id as string | undefined;
    getActiveSseWriter(threadId ?? '')?.({ type: 'wiki_oriented', wikiId, wikiName: wikiId });
    const logLines = recentLog.length
      ? recentLog.map((e) => `- [${e.date}] ${e.action} | ${e.subject}`).join('\n')
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
  },
  {
    name: 'wiki_orient',
    description:
      "Load a wiki domain's full structural state — tag taxonomy, page index, recent activity — before " +
      'searching or writing in it. Call this once you already have a wikiId (from wiki_locate or a wiki_search ' +
      'result) and want the lay of the land before deciding what to search for or write.',
    schema: WikiOrientSchema,
  },
);
