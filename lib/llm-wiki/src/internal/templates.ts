/**
 * Skeleton files written on wiki init. Pure string builders — the tag taxonomy
 * and seed content are left for the LLM-judgement layer to fill in.
 */

export interface ScaffoldContext {
  name: string;
  domain: string;
  tags: string[];
  today: string;
}

export function schemaTemplate(ctx: ScaffoldContext): string {
  return `# Wiki Schema

## Domain
${ctx.domain}

## Conventions
- File names: lowercase, hyphens, no spaces (e.g. 'example-topic.md')
- Every wiki page starts with YAML frontmatter (see below)
- Use "[[wikilinks]]" to link between pages (minimum 2 outbound links per page)
- When updating a page, always bump the "updated" date
- Every new page must be added to "index.md" under the correct section
- Every action must be appended to "log.md"
- On pages synthesizing 3+ sources, append "^[raw/articles/source.md]" at the end
  of paragraphs whose claims trace to a specific source

## Frontmatter
\`\`\`yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [from taxonomy below]
sources: [raw/articles/source-name.md]
confidence: high | medium | low
contested: true   # optional — set when page has unresolved contradictions
---
\`\`\`

## Tag Taxonomy
${ctx.tags.length ? ctx.tags.map((t) => `- ${t}`).join('\n') : '- (define 10-20 tags for this domain, grouped, before using them on pages)'}

Rule: every tag on a page must appear in this taxonomy. Add new tags here BEFORE
using them on pages.

## Page Thresholds
- **Create a page** when an entity/concept appears in 2+ sources OR is central to one source
- **Add to existing page** when a source mentions something already covered
- **DON'T create a page** for passing mentions, minor details, or out-of-domain content
- **Split a page** when it exceeds ~200 lines — break into sub-topics with cross-links
- **Archive a page** when its content is fully superseded — move to "_archive/"

## Update Policy
When new information conflicts with existing content:
1. Check the dates — newer sources generally supersede older ones
2. If genuinely contradictory, note both positions with dates and sources
3. Mark in frontmatter: "contradictions: [page-name]" and "contested: true"
4. Flag for user review in the lint report
`;
}

export function indexTemplate(ctx: ScaffoldContext): string {
  return `# Wiki Index

> Content catalog. Every wiki page listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.
> Last updated: ${ctx.today} | Total pages: 0

## Entities

## Concepts

## Comparisons

## Queries
`;
}

export function logTemplate(ctx: ScaffoldContext): string {
  return `# Wiki Log

> Chronological record of all wiki actions. Append-only.
> Format: "## [YYYY-MM-DD] action | subject"
> Actions: ingest, update, query, lint, create, archive, delete
> When this file exceeds 500 entries, rotate: rename to log-YYYY.md, start fresh.

## [${ctx.today}] create | Wiki initialized
- Domain: ${ctx.domain}
- Structure created with SCHEMA.md, index.md, log.md
`;
}
