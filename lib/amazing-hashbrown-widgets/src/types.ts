/**
 * Public types for the @tkottke90/amazing-hashbrown-widgets persistence
 * layer. JSON-serializable, shared verbatim between the API (which imports
 * the whole package) and the UI (which imports only this module via the
 * package's `./types` export, so no `node:fs`/`gray-matter` ships to the
 * browser bundle).
 */

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

export type DashboardWidget = MarkdownWidget | BigNumberWidget | LineGraphWidget | PieGraphWidget;

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

/** A dashboard — currently always the single hardcoded `default` instance. */
export interface Dashboard {
  id: string;
  name: string;
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
  | { type: 'pie-graph'; title: string; subtitle?: string; data: string; colors?: string[] };
