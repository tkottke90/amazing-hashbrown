/** Frontmatter parse/serialize (via gray-matter) + validation. Pure on strings. */

import matter from 'gray-matter';
import type { DashboardWidget, DistributiveOmit, MarkdownWidget } from '../types.js';
import { WidgetFrontmatterSchema, WIDGET_SIZE_MIN } from './widget-field-schemas.js';

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

export {
  HexColorSchema,
  MarkdownWidgetFrontmatterSchema,
  BigNumberWidgetFrontmatterSchema,
  LineGraphWidgetFrontmatterSchema,
  PieGraphWidgetFrontmatterSchema,
  WidgetFrontmatterSchema,
} from './widget-field-schemas.js';
export type { MarkdownWidgetFrontmatter, WidgetFrontmatter } from './widget-field-schemas.js';

/**
 * No `id` (it doesn't come from a filename here) and no `updatedAt` — this
 * function only ever sees raw text, never a file path, so it has no mtime to
 * attach. Callers with a path (`store.ts`) stat the file themselves and add
 * `updatedAt` on top of this result.
 */
export type WidgetFileParseResult =
  | { ok: true; widget: DistributiveOmit<DashboardWidget, 'id' | 'updatedAt'> }
  | { ok: false; error: string };

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

  // Widget Size backward compatibility (ADR-0009): a file predating `w`/`h`
  // defaults to its type's minimum, applied here rather than as a zod
  // `.default()` since the right default depends on the sibling `type`
  // field, which a per-field zod default can't see.
  const sizeMin = WIDGET_SIZE_MIN[data['type'] as keyof typeof WIDGET_SIZE_MIN];
  if (sizeMin) {
    if (typeof data['w'] !== 'number') data['w'] = sizeMin.w;
    if (typeof data['h'] !== 'number') data['h'] = sizeMin.h;
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
 * down a whole directory listing. No `updatedAt` — this function never sees
 * a file path, so it has no mtime to attach (see `WidgetFileParseResult`).
 */
export function toMarkdownWidget(id: string, raw: string): Omit<MarkdownWidget, 'updatedAt'> {
  const result = parseWidgetFile(raw);
  if (!result.ok) {
    throw new Error(result.error);
  }
  if (result.widget.type !== 'markdown') {
    throw new Error(`Expected a markdown widget, got "${result.widget.type}"`);
  }
  return { id, ...result.widget };
}
