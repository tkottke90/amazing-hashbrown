import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { fetchUrl } from '../../services/web-fetch.js';

const WebFetchInputSchema = z.object({
  url: z
    .string()
    .describe('The fully-qualified URL to fetch (must start with http:// or https://).'),
});

export const webFetchTool = tool(
  async ({ url }) => {
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

    return parts.join('\n\n');
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
