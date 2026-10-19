/**
 * Public types for the @tkottke90/amazing-hashbrown-widgets persistence
 * layer. JSON-serializable, shared verbatim between the API (which imports
 * the whole package) and the UI (which imports only this module via the
 * package's `./types` export, so no `node:fs`/`gray-matter` ships to the
 * browser bundle). `DashboardWidgetSchema` at the bottom of this file is the
 * one exception that needs a runtime import (zod, already browser-shipped
 * via `@tkottke90/llm-common-types/chat`) — it must only ever pull in the
 * zod-only `internal/widget-field-schemas.js`, never `internal/frontmatter.js`
 * (which imports `gray-matter`) or `store.js` (which imports `node:fs`).
 */

import { z } from 'zod';
import {
  MarkdownWidgetFrontmatterSchema,
  BigNumberWidgetFrontmatterSchema,
  LineGraphWidgetFrontmatterSchema,
  PieGraphWidgetFrontmatterSchema,
  SystemWidgetFrontmatterSchema,
  ResolvedMetricValueSchema,
  SpacerWidgetFrontmatterSchema,
} from './internal/widget-field-schemas.js';

export { WIDGET_SIZE_MIN, WIDGET_SIZE_MAX } from './internal/widget-field-schemas.js';

/** Fields every widget type shares, regardless of its `type`. */
export interface WidgetBase {
  /**
   * The widget's filename (without extension) — unique within its
   * dashboard's folder, and derived from it. Never duplicated inside the
   * widget's own frontmatter. Fixed at creation time; a later title edit
   * does not rename the file or change this id.
   */
  id: string;
  /** Discriminant, narrowed to a literal by each concrete variant. */
  type: string;
  title: string;
  subtitle?: string;
  /** Ascending sort key among a dashboard's widgets. */
  order: number;
  /** Widget Size (see GLOSSARY.md) — grid column/row span, clamped to `[type minimum, WIDGET_SIZE_MAX]`. */
  w: number;
  h: number;
  /** Widget Source (see GLOSSARY.md) — set by the calling code only, never request/tool-call input. */
  source: 'manual' | 'agent' | 'system';
  /** Widget Maintainer (see GLOSSARY.md) — only ever set via an agent-sourced write. */
  maintainer?: string;
  /** Derived from the widget file's own mtime (ADR-0006) — never persisted. ISO 8601. */
  updatedAt: string;
}

export interface MarkdownWidget extends WidgetBase {
  type: 'markdown';
  /** Markdown source (the file's body, below its frontmatter). */
  content: string;
}

export interface BigNumberWidget extends WidgetBase {
  type: 'big-number';
  /** Omitted (not `0`) when there's no value yet — UI renders "N/A". */
  value?: number;
  unit?: string;
}

export interface LineGraphWidget extends WidgetBase {
  type: 'line-graph';
  /** CSV Body: a `label,value` header row followed by ≥1 data row. */
  data: string;
  /** Color Override: hex string, replaces the default palette's line color. */
  color?: string;
}

export interface PieGraphWidget extends WidgetBase {
  type: 'pie-graph';
  /** CSV Body: a `label,value` header row followed by ≥1 data row. */
  data: string;
  /** Color Override: hex strings, applied positionally to parsed labels, cycling if shorter. */
  colors?: string[];
}

/**
 * What a Metric resolver hands back (see GLOSSARY.md) — keyed by
 * `displayType` rather than reusing a widget `type` literal, since a Metric's
 * display shape is independent of the fact that it's always stored as a
 * `system` widget. `pie-graph`/`line-graph` are declared now so the schema
 * shape exists, but no Metric returns them until a follow-up issue adds one.
 */
export type ResolvedMetricValue =
  | { displayType: 'big-number'; value?: number; unit?: string }
  | { displayType: 'markdown'; content: string }
  | { displayType: 'pie-graph'; labels: string[]; values: number[] }
  | { displayType: 'line-graph'; labels: string[]; values: number[] };

export interface SystemWidget extends WidgetBase {
  type: 'system';
  /** The chosen Metric's id (see GLOSSARY.md) — the only thing ever persisted for this type. */
  metric: string;
  /**
   * Live-resolved display value (see GLOSSARY.md: Metric Registry). Set only
   * by the dashboard GET handler, never by `store.ts`, never persisted to
   * the widget file, and never accepted as create/update input (ADR-0011).
   * Absent if resolution hasn't run yet or the Metric failed to resolve.
   */
  resolved?: ResolvedMetricValue;
}

/**
 * Spacer Widget (see GLOSSARY.md): pure grid-occupying whitespace, no
 * Widget Payload at all — same frontmatter-only persistence shape as
 * `BigNumberWidget` (ADR-0002), minus even that type's own optional
 * scalars.
 */
export interface SpacerWidget extends WidgetBase {
  type: 'spacer';
}

export type DashboardWidget =
  MarkdownWidget | BigNumberWidget | LineGraphWidget | PieGraphWidget | SystemWidget | SpacerWidget;

/**
 * `Omit<T, K>`, applied per-member when `T` is a union, instead of
 * collapsing to the members' common keys first (the built-in `Omit`'s
 * `keyof T` computes an intersection over a union, which silently drops
 * every field that isn't present on *every* variant — exactly the
 * type-specific fields, like `content`/`data`/`value`, that make
 * `DashboardWidget` a discriminated union in the first place). Use this
 * instead of `Omit` anywhere a widget's own `type` field must stay
 * narrowable per variant.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Dashboard Metadata (see GLOSSARY.md) — persisted per-folder in dashboard.json. */
export interface Dashboard {
  /** Permanent once created — see ADR-0016. Names the on-disk subfolder. */
  id: string;
  name: string;
  description?: string;
  density: 'compact' | 'roomy';
  /** ISO 8601, set once at creation/migration — used only to sort listDashboards(); never user-editable. */
  createdAt: string;
}

/**
 * One widget file's load outcome. A file that fails to read or validate
 * never fails the whole list — it surfaces here instead, carrying its raw
 * content so the caller can offer a remediation path.
 */
export type WidgetLoadResult =
  | { status: 'ok'; widget: DashboardWidget }
  | { status: 'error'; id: string; raw: string; error: string };

/**
 * The create/update payload for each widget type — a discriminated union on
 * `type` so the API, store, and UI drawer all validate/branch the same way.
 * Shared across all variants: `title`/`subtitle?`. `order`/`id` are never
 * part of this input — the store assigns/preserves those itself.
 */
export type WidgetContentInput =
  | { type: 'markdown'; title: string; subtitle?: string; content: string }
  | { type: 'big-number'; title: string; subtitle?: string; value?: number; unit?: string }
  | { type: 'line-graph'; title: string; subtitle?: string; data: string; color?: string }
  | { type: 'pie-graph'; title: string; subtitle?: string; data: string; colors?: string[] }
  | { type: 'system'; title: string; subtitle?: string; metric: string }
  // No title/subtitle (Q4/Q8): a Spacer Widget has no UI-editable fields
  // beyond its position and Widget Size. The store assigns a fixed
  // `title: 'Spacer'` at creation — never caller-supplied.
  | { type: 'spacer' };

/**
 * A widget before it's been stat'd for `updatedAt` — what `store.ts` builds
 * and persists. `resolved` is excluded too: it never exists at build time —
 * it's a read-time enrichment the dashboard GET handler layers on afterward,
 * never something `store.ts` builds, writes, or even knows about.
 */
export type WritableDashboardWidget = DistributiveOmit<DashboardWidget, 'updatedAt' | 'resolved'>;

/**
 * What `store.createWidget`/`updateWidget` accept: everything a caller must
 * have already decided (including `source` — ADR-0005) before persistence,
 * minus what the store itself assigns/preserves (`id`, `order`) or derives
 * (`updatedAt`). `w`/`h` (Widget Size) are excluded the same way `order` is
 * — `createWidget` always assigns the type's minimum, `updateWidget` takes
 * them as a separate optional `size` argument rather than a bare input
 * field (preserve-unless-supplied; see ADR-0008/ADR-0010 and the design
 * spec's §1 decision on `WidgetPersistInput`). Built structurally off
 * `DashboardWidget` so it can never drift from it; distinct from
 * `WidgetContentInput`, which is the UI drawer's own full-replace request
 * shape and has no `source`/`maintainer`/`w`/`h`.
 */
export type WidgetPersistInput = DistributiveOmit<
  DashboardWidget,
  'id' | 'order' | 'updatedAt' | 'w' | 'h' | 'resolved'
>;

/**
 * The full `DashboardWidget` shape, as a runtime-checkable schema — needed
 * by `lib/llm-common-types`'s `widget_updated` broadcast event, which has no
 * other way to validate an incoming SSE payload's `widget` field. Each
 * per-type Widget Frontmatter schema covers every field except `id`/
 * `updatedAt` (store-assigned/derived, never part of frontmatter) *and*
 * each type's Widget Body field (`content`/`data` — stored below the
 * frontmatter delimiter, not in it, so the frontmatter schemas never
 * declare them either).
 */
export const DashboardWidgetSchema = z.discriminatedUnion('type', [
  MarkdownWidgetFrontmatterSchema.extend({
    id: z.string(),
    updatedAt: z.string(),
    content: z.string(),
  }),
  BigNumberWidgetFrontmatterSchema.extend({ id: z.string(), updatedAt: z.string() }),
  LineGraphWidgetFrontmatterSchema.extend({
    id: z.string(),
    updatedAt: z.string(),
    data: z.string(),
  }),
  PieGraphWidgetFrontmatterSchema.extend({
    id: z.string(),
    updatedAt: z.string(),
    data: z.string(),
  }),
  SystemWidgetFrontmatterSchema.extend({
    id: z.string(),
    updatedAt: z.string(),
    resolved: ResolvedMetricValueSchema.optional(),
  }),
  SpacerWidgetFrontmatterSchema.extend({ id: z.string(), updatedAt: z.string() }),
]);
