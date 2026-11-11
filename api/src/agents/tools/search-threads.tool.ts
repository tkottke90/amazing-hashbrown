import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { getThreadStore, type ThreadMessageRecord } from '../../services/thread-store.js';
import { extractText } from '../thread-text.js';
import { rankMessages } from './thread-search-ranking.js';

const SearchThreadsSchema = z.object({
  threadId: z
    .string()
    .describe(
      "The id of a thread you already know about — e.g. from a Workspace Chat Summary's own " +
        "frontmatter (its threadId, or a supersededBy pointing at a successor thread), or from " +
        "a sub-agent completion notification's Thread: line. Never guess an id, and never use " +
        'this tool to search for one you don\'t already have — there is no discovery mode.',
    ),
  lookup: z
    .string()
    .optional()
    .describe(
      'Free-text query to rank matches within the target thread (and within start/end if also ' +
        'given). Omit to get a plain range of messages instead of a ranked search.',
    ),
  start: z
    .number()
    .int()
    .optional()
    .describe('First seq (inclusive) to include — e.g. a summary\'s covers_from_seq.'),
  end: z
    .number()
    .int()
    .optional()
    .describe('Last seq (inclusive) to include — e.g. a summary\'s covers_to_seq.'),
});

// Comfortably larger than any real workspace-chat thread's un-summarized
// tail — getThreadMessages' own `limit` caps the newest N rows *before*
// any seq-range filtering runs here, so this must be generous enough that
// a [start, end] filter further below isn't silently starved by it.
const MAX_CANDIDATE_MESSAGES = 1000;
const RANKED_LIMIT = 20; // matches search_conversation's own cap
const TAIL_LIMIT = 40; // matches read_workspace_task_run's default page size
const RANGE_LIMIT = 100; // matches read_workspace_task_run's max page size

function excerptOf(text: string): string {
  return text.length > 600 ? text.slice(0, 600) + '…' : text;
}

export const searchThreadsTool = tool(
  async ({ threadId, lookup, start, end }, config: RunnableConfig | undefined) => {
    const callerThreadId = config?.configurable?.['thread_id'] as string | undefined;
    if (callerThreadId && threadId === callerThreadId) {
      return (
        'That is your own current thread — use search_conversation instead of search_threads ' +
        'for it.'
      );
    }

    const threadStore = getThreadStore();
    if (!threadStore.getThreadMeta(threadId)) {
      return `No thread with id "${threadId}" exists.`;
    }

    // Superseded failed attempts are excluded from the search corpus, same
    // as search_conversation — a retried-over error isn't real content
    // worth citing back.
    const candidates = threadStore
      .getThreadMessages(threadId, { limit: MAX_CANDIDATE_MESSAGES })
      .filter((m) => !m.superseded);

    const inRange = candidates.filter((m) => {
      if (start !== undefined && m.seq < start) return false;
      if (end !== undefined && m.seq > end) return false;
      return true;
    });

    if (inRange.length === 0) {
      const rangeNote = start !== undefined || end !== undefined ? ' in that seq range' : '';
      return `No messages found in thread "${threadId}"${rangeNote}.`;
    }

    const corpus: { record: ThreadMessageRecord; text: string }[] = [];
    for (const msg of inRange) {
      const text = extractText(msg);
      if (text) corpus.push({ record: msg, text });
    }
    if (corpus.length === 0) return 'No searchable content in that thread/range.';

    if (lookup) {
      const texts = corpus.map((c) => c.text);
      const ranked = await rankMessages(threadId, lookup, texts, RANKED_LIMIT);
      if (ranked.length === 0) return 'No relevant messages found for that lookup.';

      const results = ranked.map(({ index, score }) => {
        const { record, text } = corpus[index]!;
        return {
          seq: record.seq,
          kind: record.kind,
          score: Math.round(score * 1000) / 1000,
          excerpt: excerptOf(text),
        };
      });
      return JSON.stringify(results, null, 2);
    }

    // No lookup: a plain range dump when start/end were given, or the most
    // recent TAIL_LIMIT messages (a tail) when neither was — never the
    // whole thread.
    const windowed =
      start === undefined && end === undefined
        ? corpus.slice(-TAIL_LIMIT)
        : corpus.slice(0, RANGE_LIMIT);

    const results = windowed.map(({ record, text }) => ({
      seq: record.seq,
      kind: record.kind,
      excerpt: excerptOf(text),
    }));
    return JSON.stringify(results, null, 2);
  },
  {
    name: 'search_threads',
    description:
      'Read or search a range of messages from a DIFFERENT thread whose id you already know — ' +
      "e.g. a past Workspace Chat thread named in a summary's frontmatter, or a sub-agent run " +
      "you dispatched. Not a discovery tool: if you don't already have the threadId, do not use " +
      "this. Never call it with your own current thread's id — use search_conversation for that. " +
      'Pass `start`/`end` (raw seq numbers, e.g. from a summary\'s covers_from_seq/covers_to_seq) ' +
      'to read a specific range, `lookup` to rank matches within that thread/range by relevance, ' +
      'or neither for the most recent messages in that thread.',
    schema: SearchThreadsSchema,
  },
);
