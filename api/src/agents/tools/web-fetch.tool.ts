import { randomBytes } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { fetchUrl } from '../../services/web-fetch.js';
import { storeToolContent } from '../../services/tool-content-store.js';
import { toolStub, type StubSection } from './tool-stub.js';

const STUB_THRESHOLD_CHARS = 10_000;

const WebFetchInputSchema = z.object({
  url: z
    .string()
    .describe('The fully-qualified URL to fetch (must start with http:// or https://).'),
});

export const webFetchTool = tool(
  async ({ url }, config) => {
    const result = await fetchUrl(url);

    if (result.status === 'robots_blocked') {
      return `robots.txt blocks access to ${result.url}.`;
    }

    if (result.status === 'error') {
      const httpNote = result.httpStatus ? ` (HTTP ${result.httpStatus})` : '';
      return `Failed to fetch ${result.url}: ${result.error}${httpNote}.`;
    }

    const parts: string[] = [`## Content\n${result.text}`];

    if (result.metadata.title || result.metadata.description) {
      const metaLines = [
        result.metadata.title && `title: "${result.metadata.title}"`,
        result.metadata.description && `description: "${result.metadata.description}"`,
      ]
        .filter(Boolean)
        .join('\n');
      parts.push(`## Metadata\n${metaLines}`);
    }

    if (result.links.length) {
      const linkLines = result.links.map((l) => `- [${l.text || l.href}](${l.href})`).join('\n');
      parts.push(`## Links\n${linkLines}`);
    }

    if (result.outline.length) {
      const outlineLines = result.outline
        .map((h) => `${'  '.repeat(h.level - 1)}H${h.level}: ${h.text}`)
        .join('\n');
      parts.push(`## Document Outline\n${outlineLines}`);
    }

    const fullContent = parts.join('\n\n');
    const threadId = config?.configurable?.thread_id as string | undefined;

    if (fullContent.length > STUB_THRESHOLD_CHARS && threadId) {
      const toolKey = `kv_${randomBytes(4).toString('hex')}`;
      storeToolContent(threadId, toolKey, fullContent);

      const summary =
        result.metadata.description ?? result.text.slice(0, 300).replace(/\s+/g, ' ').trim();

      const keyConcepts = result.outline
        .filter((h) => h.level <= 2)
        .slice(0, 5)
        .map((h) => h.text)
        .join(', ');

      const pageTitle = result.metadata.title ?? '<title>';
      const wikiInstruction = [
        `wiki_create_page({`,
        `  title:   "${pageTitle}",`,
        `  section: <entity|concept|comparison|query|summary>,`,
        `  corpus: {`,
        `    threadId: "${threadId}",`,
        `    toolKey:  "${toolKey}"`,
        `  }`,
        `})`,
      ].join('\n');

      const sections: StubSection[] = [{ name: 'summary', content: summary }];
      if (keyConcepts) {
        sections.push({ name: 'key concepts', content: keyConcepts });
      }
      sections.push({ name: 'to ingest into wiki:', content: wikiInstruction });

      return toolStub(
        {
          tool: 'web_fetch',
          chars: result.text.length,
          key: toolKey,
          threadId,
          type: result.contentType,
        },
        sections,
      );
    }

    return fullContent;
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its content in a readable format. ' +
      'For HTML pages, returns the article body in reader mode, page title and description, ' +
      'up to 50 outbound links, and a heading outline (H1–H3). ' +
      'For JSON endpoints, returns the pretty-printed JSON. ' +
      'Use this when the user gives you an explicit URL to read, or when answering a question ' +
      'requires live or recent information not available in the wiki. ' +
      'Do NOT use this for general knowledge questions (answer from training) or for topics ' +
      'that may already be in the wiki — use wiki_search first instead.',
    schema: WebFetchInputSchema,
  },
);
