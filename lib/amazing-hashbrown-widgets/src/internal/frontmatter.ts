/** Frontmatter parse/serialize (via gray-matter) + validation. Pure on strings. */

import matter from 'gray-matter';
import { z } from 'zod';
import type { DashboardWidget, DistributiveOmit, MarkdownWidget } from '../types.js';

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

/** A Color Override value: `#rgb` or `#rrggbb`, case-insensitive. */
export const HexColorSchema = z
  .string()
  .regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, 'Expected a hex color (#rgb or #rrggbb)');

/** Validated shape of a `MarkdownWidget`'s frontmatter block (no `id`/`content` — those come from the filename and body). */
export const MarkdownWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('markdown'),
  order: z.number(),
});

/** Validated shape of a `BigNumberWidget`'s frontmatter block (no body). */
export const BigNumberWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('big-number'),
  order: z.number(),
  value: z.number().optional(),
  unit: z.string().optional(),
});

/** Validated shape of a `LineGraphWidget`'s frontmatter block (`data` CSV Body is validated separately, see `parseCsvBody`). */
export const LineGraphWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('line-graph'),
  order: z.number(),
  color: HexColorSchema.optional(),
});

/** Validated shape of a `PieGraphWidget`'s frontmatter block (`data` CSV Body is validated separately, see `parseCsvBody`). */
export const PieGraphWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('pie-graph'),
  order: z.number(),
  colors: z.array(HexColorSchema).optional(),
});

export const WidgetFrontmatterSchema = z.discriminatedUnion('type', [
  MarkdownWidgetFrontmatterSchema,
  BigNumberWidgetFrontmatterSchema,
  LineGraphWidgetFrontmatterSchema,
  PieGraphWidgetFrontmatterSchema,
]);

export type MarkdownWidgetFrontmatter = z.infer<typeof MarkdownWidgetFrontmatterSchema>;
export type WidgetFrontmatter = z.infer<typeof WidgetFrontmatterSchema>;

export type WidgetFileParseResult =
  { ok: true; widget: DistributiveOmit<DashboardWidget, 'id'> } | { ok: false; error: string };

export interface CsvBodyData {
  labels: string[];
  values: number[];
}

export type CsvBodyParseResult = { ok: true; data: CsvBodyData } | { ok: false; error: string };

/**
 * Parse a Line Graph / Pie Graph widget's CSV Body: a required `label,value`
 * header row followed by ≥1 data row, each exactly two columns. No
 * quoted-field escaping — a label containing a comma (or any row that isn't
 * exactly two columns) is a validation error, not an edge case to support.
 */
export function parseCsvBody(raw: string): CsvBodyParseResult {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      ok: false,
      error: 'CSV body is empty; expected a "label,value" header row and at least one data row.',
    };
  }
  if (lines[0] !== 'label,value') {
    return {
      ok: false,
      error: `CSV body must start with the header row "label,value", got "${lines[0]}".`,
    };
  }

  const dataLines = lines.slice(1);
  if (dataLines.length === 0) {
    return {
      ok: false,
      error: 'CSV body must have at least one data row below the "label,value" header.',
    };
  }

  const labels: string[] = [];
  const values: number[] = [];
  for (const line of dataLines) {
    const parts = line.split(',');
    if (parts.length !== 2) {
      return {
        ok: false,
        error: `CSV row "${line}" must have exactly two columns (label,value); a label containing a comma isn't supported.`,
      };
    }
    const [labelText, valueText] = parts as [string, string];
    const label = labelText.trim();
    const value = Number(valueText.trim());
    if (!Number.isFinite(value)) {
      return {
        ok: false,
        error: `CSV value "${valueText.trim()}" for label "${label}" is not a number.`,
      };
    }
    labels.push(label);
    values.push(value);
  }

  return { ok: true, data: { labels, values } };
}

function assertNeverWidgetType(type: never): never {
  throw new Error(`Unhandled widget type: ${type}`);
}

/**
 * Pure dry-run parse + validate of a widget file's raw text — no `id` (it
 * doesn't come from a filename here) and no disk I/O. Never throws:
 * `parse(raw)` itself can throw on malformed YAML, so that's caught and
 * folded into the same `{ok:false}` shape as a schema failure. This is the
 * one implementation of "is this file well-formed" shared by `listWidgets`
 * and `POST /api/v1/widgets/validate`.
 */
export function parseWidgetFile(raw: string): WidgetFileParseResult {
  let data: Record<string, unknown>;
  let body: string;
  try {
    ({ data, body } = parse(raw));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = WidgetFrontmatterSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `Invalid widget frontmatter: ${issues}` };
  }

  switch (result.data.type) {
    case 'markdown':
      return { ok: true, widget: { content: body, ...result.data } };
    case 'big-number':
      return { ok: true, widget: { ...result.data } };
    case 'line-graph': {
      const csv = parseCsvBody(body);
      if (!csv.ok) return { ok: false, error: csv.error };
      return { ok: true, widget: { ...result.data, data: body } };
    }
    case 'pie-graph': {
      const csv = parseCsvBody(body);
      if (!csv.ok) return { ok: false, error: csv.error };
      if (csv.data.values.some((value) => value < 0)) {
        return { ok: false, error: 'Pie Graph values must be non-negative.' };
      }
      return { ok: true, widget: { ...result.data, data: body } };
    }
    default:
      return assertNeverWidgetType(result.data);
  }
}

/**
 * Parse + validate a widget file's raw content into a `MarkdownWidget`.
 * Throws (with a human-readable message) on any parse or validation
 * failure, including a well-formed file of a different widget type —
 * callers are expected to catch this per-file so one bad file doesn't take
 * down a whole directory listing.
 */
export function toMarkdownWidget(id: string, raw: string): MarkdownWidget {
  const result = parseWidgetFile(raw);
  if (!result.ok) {
    throw new Error(result.error);
  }
  if (result.widget.type !== 'markdown') {
    throw new Error(`Expected a markdown widget, got "${result.widget.type}"`);
  }
  return { id, ...result.widget };
}
