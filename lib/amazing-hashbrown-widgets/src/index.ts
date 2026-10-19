/**
 * @tkottke90/amazing-hashbrown-widgets — file-backed persistence for
 * dashboard widgets. See README-less design doc:
 * docs/superpowers/specs/2026-10-16-dashboard-widgets-slice2-design.md
 */

export {
  listWidgets,
  loadWidget,
  createWidget,
  updateWidget,
  updateWidgetRaw,
  deleteWidget,
  reorderWidget,
  ensureSeeded,
  peekWidgetFrontmatter,
  WidgetNotFoundError,
  listDashboards,
  getDashboardMetadata,
  createDashboard,
  updateDashboardMetadata,
  deleteDashboard,
  migrateDefaultDashboardMetadata,
} from './store.js';

export { parseWidgetFile, parseCsvBody } from './internal/frontmatter.js';
export type {
  WidgetFileParseResult,
  CsvBodyData,
  CsvBodyParseResult,
} from './internal/frontmatter.js';

export * from './types.js';
