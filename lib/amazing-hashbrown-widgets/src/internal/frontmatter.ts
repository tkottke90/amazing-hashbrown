/** Frontmatter parse/serialize (via gray-matter) + validation. Pure on strings. */

import matter from 'gray-matter';
import { z } from 'zod';
import type { MarkdownWidget } from '../types.js';

export interface ParsedWidgetFile {
  data: Record<string, unknown>;
  body: string;
}

/** Split a widget markdown file into frontmatter data + body. */
export function parse(raw: string): ParsedWidgetFile {
  const { data, content } = matter(raw);
  return { data, body: content };
}

/** Serialize frontmatter + body back into a markdown document. */
export function serialize(frontmatter: Record<string, unknown>, body: string): string {
  // gray-matter appends a trailing newline; normalize the body's leading space.
  return matter.stringify(body.replace(/^\n+/, ''), frontmatter);
}

/** Validated shape of a `MarkdownWidget`'s frontmatter block (no `id`/`content` — those come from the filename and body). */
export const MarkdownWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('markdown'),
  order: z.number(),
});

export type MarkdownWidgetFrontmatter = z.infer<typeof MarkdownWidgetFrontmatterSchema>;

/**
 * Parse + validate a widget file's raw content into a `MarkdownWidget`.
 * Throws (with a human-readable message) on any parse or validation
 * failure — callers are expected to catch this per-file so one bad file
 * doesn't take down a whole directory listing.
 */
export function toMarkdownWidget(id: string, raw: string): MarkdownWidget {
  const { data, body } = parse(raw);
  const result = MarkdownWidgetFrontmatterSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid widget frontmatter: ${issues}`);
  }
  return { id, content: body, ...result.data };
}
