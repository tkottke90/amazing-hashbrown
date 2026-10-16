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

export type DashboardWidget = MarkdownWidget;
// Future slices add: | BigNumberWidget | LineGraphWidget | PieGraphWidget

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
