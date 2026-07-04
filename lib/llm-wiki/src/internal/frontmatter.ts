/** Frontmatter parse/serialize (via gray-matter) + validation. Pure on strings. */

import matter from 'gray-matter';
import type { PageFrontmatter, PageType } from '../types.js';

/** Frontmatter fields every content page must define. */
export const REQUIRED_FRONTMATTER = [
  'title',
  'created',
  'updated',
  'type',
  'tags',
  'sources',
] as const;

export interface ParsedPage {
  data: Record<string, unknown>;
  body: string;
}

/** Split a markdown document into frontmatter data + body. */
export function parse(raw: string): ParsedPage {
  const { data, content } = matter(raw);
  return { data, body: content };
}

/** Serialize frontmatter + body back into a markdown document. */
export function serialize(frontmatter: Record<string, unknown>, body: string): string {
  // gray-matter appends a trailing newline; normalize the body's leading space.
  return matter.stringify(body.replace(/^\n+/, ''), frontmatter);
}

/** Missing required frontmatter fields (empty array = valid). */
export function missingRequired(data: Record<string, unknown>): string[] {
  return REQUIRED_FRONTMATTER.filter((key) => {
    const value = data[key];
    if (value === undefined || value === null || value === '') return true;
    if ((key === 'tags' || key === 'sources') && !Array.isArray(value)) return true;
    return false;
  });
}

/** Coerce parsed data into a typed PageFrontmatter (best-effort). */
export function toFrontmatter(data: Record<string, unknown>): PageFrontmatter {
  return {
    ...data,
    title: String(data.title ?? ''),
    created: String(data.created ?? ''),
    updated: String(data.updated ?? ''),
    type: (data.type as PageType) ?? 'concept',
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
  };
}

/**
 * Extract the tag taxonomy from a SCHEMA.md string. Tags are read from the
 * `## Tag Taxonomy` section: any comma/space-separated tokens after an optional
 * `Group:` label on each `- ` bullet. Returns a lowercase set.
 */
export function parseTaxonomy(schema: string): Set<string> {
  const tags = new Set<string>();
  const section = /##\s*Tag Taxonomy\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/.exec(schema);
  if (!section) return tags;
  for (const line of section[1]!.split('\n')) {
    const bullet = /^\s*-\s+(.*)$/.exec(line);
    if (!bullet) continue;
    let rest = bullet[1]!;
    // Drop a leading "Group:" label if present (e.g. "Hosts: host, vm").
    const colon = rest.indexOf(':');
    if (colon !== -1) rest = rest.slice(colon + 1);
    for (const token of rest.split(',')) {
      const tag = token.trim().toLowerCase();
      if (tag && !tag.startsWith('(')) tags.add(tag);
    }
  }
  return tags;
}
