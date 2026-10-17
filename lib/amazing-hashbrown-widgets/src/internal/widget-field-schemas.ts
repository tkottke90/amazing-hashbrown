/**
 * Per-type Widget Frontmatter field schemas (zod-only, no other imports) —
 * split out of `frontmatter.ts` so they're reachable from `types.ts` (and
 * therefore the package's browser-safe `./types` subpath) without dragging
 * `gray-matter` along. `frontmatter.ts` imports these back for
 * `parseWidgetFile`.
 */

import { z } from 'zod';

/** A Color Override value: `#rgb` or `#rrggbb`, case-insensitive. */
export const HexColorSchema = z
  .string()
  .regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, 'Expected a hex color (#rgb or #rrggbb)');

/**
 * Widget Source (see GLOSSARY.md). Defaults to `'manual'` so a widget file
 * that predates this field still parses with a concrete value (ADR-0006/D13)
 * rather than `undefined`.
 */
const WidgetSourceSchema = z.enum(['manual', 'agent', 'system']).optional().default('manual');

/** Widget Maintainer (see GLOSSARY.md) — only ever set via an agent-sourced write. */
const WidgetMaintainerSchema = z.string().optional();

/** Validated shape of a `MarkdownWidget`'s frontmatter block (no `id`/`content` — those come from the filename and body). */
export const MarkdownWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('markdown'),
  order: z.number(),
  source: WidgetSourceSchema,
  maintainer: WidgetMaintainerSchema,
});

/** Validated shape of a `BigNumberWidget`'s frontmatter block (no body). */
export const BigNumberWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('big-number'),
  order: z.number(),
  value: z.number().optional(),
  unit: z.string().optional(),
  source: WidgetSourceSchema,
  maintainer: WidgetMaintainerSchema,
});

/** Validated shape of a `LineGraphWidget`'s frontmatter block (`data` CSV Body is validated separately, see `parseCsvBody`). */
export const LineGraphWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('line-graph'),
  order: z.number(),
  color: HexColorSchema.optional(),
  source: WidgetSourceSchema,
  maintainer: WidgetMaintainerSchema,
});

/** Validated shape of a `PieGraphWidget`'s frontmatter block (`data` CSV Body is validated separately, see `parseCsvBody`). */
export const PieGraphWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('pie-graph'),
  order: z.number(),
  colors: z.array(HexColorSchema).optional(),
  source: WidgetSourceSchema,
  maintainer: WidgetMaintainerSchema,
});

export const WidgetFrontmatterSchema = z.discriminatedUnion('type', [
  MarkdownWidgetFrontmatterSchema,
  BigNumberWidgetFrontmatterSchema,
  LineGraphWidgetFrontmatterSchema,
  PieGraphWidgetFrontmatterSchema,
]);

export type MarkdownWidgetFrontmatter = z.infer<typeof MarkdownWidgetFrontmatterSchema>;
export type WidgetFrontmatter = z.infer<typeof WidgetFrontmatterSchema>;
