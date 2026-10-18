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

/**
 * Widget Size (see GLOSSARY.md) per-type minimums, and the shared maximum
 * every type clamps to — `[type minimum, WIDGET_SIZE_MAX]` (ADR-0010,
 * design spec §1.2). Values come from #179's own issue text, the only
 * source of real sizing numbers in this repo (design spec, Problem section).
 */
export const WIDGET_SIZE_MIN: Record<
  'markdown' | 'big-number' | 'line-graph' | 'pie-graph' | 'system' | 'spacer',
  { w: number; h: number }
> = {
  'big-number': { w: 2, h: 2 },
  'line-graph': { w: 4, h: 3 },
  'pie-graph': { w: 4, h: 3 },
  markdown: { w: 3, h: 2 },
  // Shares Markdown's floor — a Metric's resolved shape (big-number or
  // markdown, for now) isn't known until read time, so the stored widget
  // type alone can't pick a tighter minimum the way the other types do.
  system: { w: 3, h: 2 },
  // Smaller than any content widget's minimum (Q5) — a Spacer Widget's
  // whole purpose is fine-grained whitespace control (see GLOSSARY.md).
  spacer: { w: 1, h: 1 },
};

export const WIDGET_SIZE_MAX = { w: 12, h: 8 } as const;

/** Validated shape of a `MarkdownWidget`'s frontmatter block (no `id`/`content` — those come from the filename and body). */
export const MarkdownWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('markdown'),
  order: z.number(),
  w: z.number().min(WIDGET_SIZE_MIN.markdown.w).max(WIDGET_SIZE_MAX.w),
  h: z.number().min(WIDGET_SIZE_MIN.markdown.h).max(WIDGET_SIZE_MAX.h),
  source: WidgetSourceSchema,
  maintainer: WidgetMaintainerSchema,
});

/** Validated shape of a `BigNumberWidget`'s frontmatter block (no body). */
export const BigNumberWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('big-number'),
  order: z.number(),
  w: z.number().min(WIDGET_SIZE_MIN['big-number'].w).max(WIDGET_SIZE_MAX.w),
  h: z.number().min(WIDGET_SIZE_MIN['big-number'].h).max(WIDGET_SIZE_MAX.h),
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
  w: z.number().min(WIDGET_SIZE_MIN['line-graph'].w).max(WIDGET_SIZE_MAX.w),
  h: z.number().min(WIDGET_SIZE_MIN['line-graph'].h).max(WIDGET_SIZE_MAX.h),
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
  w: z.number().min(WIDGET_SIZE_MIN['pie-graph'].w).max(WIDGET_SIZE_MAX.w),
  h: z.number().min(WIDGET_SIZE_MIN['pie-graph'].h).max(WIDGET_SIZE_MAX.h),
  colors: z.array(HexColorSchema).optional(),
  source: WidgetSourceSchema,
  maintainer: WidgetMaintainerSchema,
});

/**
 * Validated shape of a `SystemWidget`'s frontmatter block (no body — see
 * GLOSSARY.md: System Widget). Deliberately has **no `maintainer` field at
 * all** — not even `.optional()` — so ADR-0012 ("system widgets never have
 * a maintainer") is enforced by the schema itself: a hand-edited file that
 * adds one fails validation instead of silently being accepted and ignored.
 */
export const SystemWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('system'),
  order: z.number(),
  w: z.number().min(WIDGET_SIZE_MIN.system.w).max(WIDGET_SIZE_MAX.w),
  h: z.number().min(WIDGET_SIZE_MIN.system.h).max(WIDGET_SIZE_MAX.h),
  metric: z.string().min(1),
  source: WidgetSourceSchema,
});

/**
 * Validated shape of a `SpacerWidget`'s frontmatter block (no body — see
 * GLOSSARY.md's Spacer Widget entry). `title` is still a required field
 * here, same as every other type's frontmatter — the API layer never lets
 * a caller supply anything but the fixed `'Spacer'` value for it (see
 * `dashboards.handlers.ts`), but the persisted file still carries a real
 * `title` string like every other widget file.
 */
export const SpacerWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('spacer'),
  order: z.number(),
  w: z.number().min(WIDGET_SIZE_MIN.spacer.w).max(WIDGET_SIZE_MAX.w),
  h: z.number().min(WIDGET_SIZE_MIN.spacer.h).max(WIDGET_SIZE_MAX.h),
  source: WidgetSourceSchema,
  maintainer: WidgetMaintainerSchema,
});

export const WidgetFrontmatterSchema = z.discriminatedUnion('type', [
  MarkdownWidgetFrontmatterSchema,
  BigNumberWidgetFrontmatterSchema,
  LineGraphWidgetFrontmatterSchema,
  PieGraphWidgetFrontmatterSchema,
  SystemWidgetFrontmatterSchema,
  SpacerWidgetFrontmatterSchema,
]);

export type MarkdownWidgetFrontmatter = z.infer<typeof MarkdownWidgetFrontmatterSchema>;
export type WidgetFrontmatter = z.infer<typeof WidgetFrontmatterSchema>;

/**
 * What a Metric resolver hands back (see GLOSSARY.md: Metric, Metric
 * Registry) — mirrors `ResolvedMetricValue` in `types.ts`. Lives here,
 * zod-only, so `types.ts` can import it without pulling in `gray-matter`/
 * `node:fs` (see this file's header comment and `types.ts`'s). `pie-graph`/
 * `line-graph` are declared for schema completeness; no wave-1 Metric
 * returns them.
 */
export const ResolvedMetricValueSchema = z.discriminatedUnion('displayType', [
  z.object({
    displayType: z.literal('big-number'),
    value: z.number().optional(),
    unit: z.string().optional(),
  }),
  z.object({
    displayType: z.literal('markdown'),
    content: z.string(),
  }),
  z.object({
    displayType: z.literal('pie-graph'),
    labels: z.array(z.string()),
    values: z.array(z.number()),
  }),
  z.object({
    displayType: z.literal('line-graph'),
    labels: z.array(z.string()),
    values: z.array(z.number()),
  }),
]);
