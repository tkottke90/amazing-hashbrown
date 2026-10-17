/**
 * File-backed persistence for dashboard widgets. One subfolder per
 * dashboard (`<root>/<dashboardId>/`), one `<slug>.md` frontmatter file
 * per widget. Every exported function is a plain async function
 * parameterized by `root`/`dashboardId` — no singleton, no async
 * construction step to memoize.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as frontmatter from './internal/frontmatter.js';
import { slugify, withCollisionSuffix } from './internal/slug.js';
import type {
  DashboardWidget,
  MarkdownWidget,
  WidgetContentInput,
  WidgetLoadResult,
  WidgetPersistInput,
  WritableDashboardWidget,
} from './types.js';

/** Thrown when a widget id (or dashboard id) doesn't resolve to a file on disk. */
export class WidgetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WidgetNotFoundError';
  }
}

const MAX_SLUG_COLLISION_ATTEMPTS = 5;

/**
 * `dashboardId`/widget `id` are used to build filesystem paths, and both
 * ultimately come from a URL route param one layer up — reject anything
 * that could escape the intended directory before it reaches `path.join`.
 */
function assertSafeSegment(value: string, kind: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error(`Invalid ${kind}: ${JSON.stringify(value)}`);
  }
}

function dashboardDir(root: string, dashboardId: string): string {
  assertSafeSegment(dashboardId, 'dashboardId');
  return path.join(root, dashboardId);
}

function widgetPath(root: string, dashboardId: string, id: string): string {
  assertSafeSegment(id, 'widget id');
  return path.join(dashboardDir(root, dashboardId), `${id}.md`);
}

async function listMarkdownFilenames(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith('.md'));
}

/**
 * List every widget in a dashboard's folder. A file that fails to read or
 * validate becomes a `{status:'error'}` entry carrying its raw content —
 * it never fails the whole list. `ok` entries sort by `order` ascending;
 * `error` entries (whose `order`, if any, isn't trustworthy) are appended
 * after, in filename order.
 */
export async function listWidgets(root: string, dashboardId: string): Promise<WidgetLoadResult[]> {
  const dir = dashboardDir(root, dashboardId);
  const filenames = await listMarkdownFilenames(dir);

  const results: WidgetLoadResult[] = [];
  for (const filename of filenames) {
    const id = filename.slice(0, -'.md'.length);
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, filename), 'utf8');
    } catch (err) {
      results.push({ status: 'error', id, raw: '', error: (err as Error).message });
      continue;
    }
    const parsed = frontmatter.parseWidgetFile(raw);
    if (parsed.ok) {
      const stat = await fs.stat(path.join(dir, filename));
      results.push({
        status: 'ok',
        widget: { id, ...parsed.widget, updatedAt: stat.mtime.toISOString() },
      });
    } else {
      results.push({ status: 'error', id, raw, error: parsed.error });
    }
  }

  const ok = results.filter(
    (r): r is { status: 'ok'; widget: DashboardWidget } => r.status === 'ok',
  );
  const errors = results.filter((r) => r.status === 'error');
  ok.sort((a, b) => a.widget.order - b.widget.order);
  return [...ok, ...errors];
}

async function nextOrder(root: string, dashboardId: string): Promise<number> {
  const results = await listWidgets(root, dashboardId);
  const orders = results
    .filter((r): r is { status: 'ok'; widget: DashboardWidget } => r.status === 'ok')
    .map((r) => r.widget.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

function assertNeverWidgetType(type: never): never {
  throw new Error(`Unhandled widget type: ${type}`);
}

/** Build the typed widget object for a given id/order from a create/update input. */
function buildWidget(
  id: string,
  order: number,
  input: WidgetPersistInput,
): WritableDashboardWidget {
  const base = {
    id,
    title: input.title,
    subtitle: input.subtitle,
    order,
    source: input.source,
    maintainer: input.maintainer,
  };
  switch (input.type) {
    case 'markdown':
      return { ...base, type: 'markdown', content: input.content };
    case 'big-number':
      return { ...base, type: 'big-number', value: input.value, unit: input.unit };
    case 'line-graph':
      return { ...base, type: 'line-graph', data: input.data, color: input.color };
    case 'pie-graph':
      return { ...base, type: 'pie-graph', data: input.data, colors: input.colors };
    default:
      return assertNeverWidgetType(input);
  }
}

/** Create a new widget of any type. Slugifies `title`; a filename collision gets a UUID suffix. */
export async function createWidget(
  root: string,
  dashboardId: string,
  input: WidgetPersistInput,
): Promise<DashboardWidget> {
  const dir = dashboardDir(root, dashboardId);
  await fs.mkdir(dir, { recursive: true });

  let slug = slugify(input.title) || 'widget';
  for (let attempt = 0; attempt < MAX_SLUG_COLLISION_ATTEMPTS; attempt++) {
    const exists = await fs
      .access(path.join(dir, `${slug}.md`))
      .then(() => true)
      .catch(() => false);
    if (!exists) break;
    slug = withCollisionSuffix(slugify(input.title) || 'widget');
  }

  const order = await nextOrder(root, dashboardId);
  const widget = buildWidget(slug, order, input);
  await writeWidgetFile(root, dashboardId, widget);
  const stat = await fs.stat(widgetPath(root, dashboardId, widget.id));
  return { ...widget, updatedAt: stat.mtime.toISOString() };
}

/**
 * Write a widget's frontmatter + body, per its type's persistence shape
 * (ADR-0002): Markdown's body is its prose `content`; Big Number has no
 * body; Line/Pie Graph's body is their CSV Body (`data`), verbatim. Dumb
 * persistence (ADR-0005): writes exactly the `source`/`maintainer` it's
 * handed, never computing or defaulting either itself.
 */
async function writeWidgetFile(
  root: string,
  dashboardId: string,
  widget: WritableDashboardWidget,
): Promise<void> {
  const filePath = widgetPath(root, dashboardId, widget.id);
  const data: Record<string, unknown> = {
    title: widget.title,
    type: widget.type,
    order: widget.order,
    source: widget.source,
  };
  if (widget.subtitle !== undefined) data.subtitle = widget.subtitle;
  if (widget.maintainer !== undefined) data.maintainer = widget.maintainer;

  let body: string;
  switch (widget.type) {
    case 'markdown':
      body = widget.content;
      break;
    case 'big-number':
      if (widget.value !== undefined) data.value = widget.value;
      if (widget.unit !== undefined) data.unit = widget.unit;
      body = '';
      break;
    case 'line-graph':
      if (widget.color !== undefined) data.color = widget.color;
      body = widget.data;
      break;
    case 'pie-graph':
      if (widget.colors !== undefined) data.colors = widget.colors;
      body = widget.data;
      break;
    default:
      return assertNeverWidgetType(widget);
  }

  await fs.writeFile(filePath, frontmatter.serialize(data, body), 'utf8');
}

async function readOrThrowNotFound(filePath: string, id: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    throw new WidgetNotFoundError(`Widget "${id}" not found`);
  }
}

/**
 * Update an existing widget's title/subtitle/type-specific fields. The
 * filename never changes, and `order` is read from the existing file and
 * preserved — this endpoint never assigns a new one. `input.type` is
 * expected to match the widget's existing type (type is immutable after
 * creation — no UI affordance changes it); this layer trusts that
 * invariant rather than re-checking it, matching the API layer's own
 * validation of the request body against the existing resource. Dumb
 * persistence (ADR-0005): writes exactly the `source`/`maintainer` already
 * computed by the caller (the drawer handler vs. the content handler each
 * decide their own), never hardcoding either itself.
 */
export async function updateWidget(
  root: string,
  dashboardId: string,
  id: string,
  input: WidgetPersistInput,
): Promise<DashboardWidget> {
  const filePath = widgetPath(root, dashboardId, id);
  const raw = await readOrThrowNotFound(filePath, id);
  const { data } = frontmatter.parse(raw);
  const order = typeof data.order === 'number' ? data.order : 0;

  const widget = buildWidget(id, order, input);
  await writeWidgetFile(root, dashboardId, widget);
  const stat = await fs.stat(filePath);
  return { ...widget, updatedAt: stat.mtime.toISOString() };
}

/**
 * Load a single widget by id. Returns `null` for a missing file or one that
 * fails to parse/validate — both read as "not found" to the content-update
 * handler, which has no separate remediation path (that's the raw-mode
 * editor's job, reached only through `listWidgets`' `{status:'error'}`
 * entries).
 */
export async function loadWidget(
  root: string,
  dashboardId: string,
  id: string,
): Promise<DashboardWidget | null> {
  const filePath = widgetPath(root, dashboardId, id);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const parsed = frontmatter.parseWidgetFile(raw);
  if (!parsed.ok) return null;
  const stat = await fs.stat(filePath);
  return { id, ...parsed.widget, updatedAt: stat.mtime.toISOString() };
}

/**
 * Overwrite a widget file's raw content verbatim — no parse/validate
 * step. Used to let a user repair a widget whose frontmatter failed to
 * parse; a still-broken save just surfaces the same error again on the
 * next `listWidgets` call. The file must already exist (this repairs a
 * widget, it doesn't create one).
 */
export async function updateWidgetRaw(
  root: string,
  dashboardId: string,
  id: string,
  raw: string,
): Promise<void> {
  const filePath = widgetPath(root, dashboardId, id);
  await readOrThrowNotFound(filePath, id);
  await fs.writeFile(filePath, raw, 'utf8');
}

export async function deleteWidget(root: string, dashboardId: string, id: string): Promise<void> {
  const filePath = widgetPath(root, dashboardId, id);
  try {
    await fs.unlink(filePath);
  } catch {
    throw new WidgetNotFoundError(`Widget "${id}" not found`);
  }
}

const SEED_WIDGETS: Extract<WidgetContentInput, { type: 'markdown' }>[] = [
  {
    type: 'markdown',
    title: 'Welcome',
    subtitle: 'Your AI Workspace',
    content:
      '# Welcome to Amazing Hashbrown\n\nThis is your central dashboard for all AI-powered features.',
  },
  {
    type: 'markdown',
    title: 'Getting Started',
    subtitle: 'A few things to try',
    content:
      '## Getting Started\n\n- Start a chat from the sidebar\n- Browse the **Wiki** for ingested knowledge\n- Check **Workspaces** for active projects\n- Visit **Settings** to configure providers and tools',
  },
  {
    type: 'markdown',
    title: 'Tip',
    content:
      'You can fork any thread to explore a different direction without losing the original.',
  },
  {
    type: 'markdown',
    title: "What's New",
    subtitle: 'Recent changes',
    content:
      '### Dashboard\n\nThis dashboard is new! More widget types and the ability to customize your layout are coming in future updates.',
  },
];

/**
 * If `<root>/<dashboardId>/` is missing or has no `.md` files, create it
 * and write the sample widgets as real files. A no-op otherwise. Seed data
 * stays Markdown-only by design — no requirement to seed the other types.
 */
export async function ensureSeeded(root: string, dashboardId: string): Promise<void> {
  const dir = dashboardDir(root, dashboardId);
  const filenames = await listMarkdownFilenames(dir);
  if (filenames.length > 0) return;

  await fs.mkdir(dir, { recursive: true });
  for (let order = 0; order < SEED_WIDGETS.length; order++) {
    const seed = SEED_WIDGETS[order]!;
    const widget: Omit<MarkdownWidget, 'updatedAt'> = {
      id: slugify(seed.title) || `widget-${order}`,
      type: 'markdown',
      title: seed.title,
      subtitle: seed.subtitle,
      order,
      source: 'manual',
      content: seed.content,
    };
    await writeWidgetFile(root, dashboardId, widget);
  }
}
