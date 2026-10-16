/**
 * @tkottke90/amazing-hashbrown-widgets — file-backed persistence for
 * dashboard widgets. See README-less design doc:
 * docs/superpowers/specs/2026-10-16-dashboard-widgets-slice2-design.md
 */

export {
  listWidgets,
  createWidget,
  updateWidget,
  updateWidgetRaw,
  deleteWidget,
  ensureSeeded,
  WidgetNotFoundError,
} from './store.js';
export type { WidgetContentInput } from './store.js';

export { parseWidgetFile } from './internal/frontmatter.js';
export type { WidgetFileParseResult } from './internal/frontmatter.js';

export * from './types.js';
