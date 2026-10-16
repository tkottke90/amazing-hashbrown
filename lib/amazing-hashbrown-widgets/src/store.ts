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
import type { MarkdownWidget, WidgetLoadResult } from './types.js';

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
      results.push({ status: 'ok', widget: { id, ...parsed.widget } });
    } else {
      results.push({ status: 'error', id, raw, error: parsed.error });
    }
  }

  const ok = results.filter(
    (r): r is { status: 'ok'; widget: MarkdownWidget } => r.status === 'ok',
  );
  const errors = results.filter((r) => r.status === 'error');
  ok.sort((a, b) => a.widget.order - b.widget.order);
  return [...ok, ...errors];
}

async function nextOrder(root: string, dashboardId: string): Promise<number> {
  const results = await listWidgets(root, dashboardId);
  const orders = results
    .filter((r): r is { status: 'ok'; widget: MarkdownWidget } => r.status === 'ok')
    .map((r) => r.widget.order);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

export interface WidgetContentInput {
  title: string;
  subtitle?: string;
  content: string;
}

/** Create a new Markdown widget. Slugifies `title`; a filename collision gets a UUID suffix. */
export async function createWidget(
  root: string,
  dashboardId: string,
  input: WidgetContentInput,
): Promise<MarkdownWidget> {
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
  const widget: MarkdownWidget = {
    id: slug,
    type: 'markdown',
    title: input.title,
    subtitle: input.subtitle,
    order,
    content: input.content,
  };
  await writeWidgetFile(root, dashboardId, widget);
  return widget;
}

async function writeWidgetFile(
  root: string,
  dashboardId: string,
  widget: MarkdownWidget,
): Promise<void> {
  const filePath = widgetPath(root, dashboardId, widget.id);
  const data: Record<string, unknown> = {
    title: widget.title,
    type: widget.type,
    order: widget.order,
  };
  if (widget.subtitle !== undefined) data.subtitle = widget.subtitle;
  await fs.writeFile(filePath, frontmatter.serialize(data, widget.content), 'utf8');
}

async function readOrThrowNotFound(filePath: string, id: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    throw new WidgetNotFoundError(`Widget "${id}" not found`);
  }
}

/**
 * Update an existing Markdown widget's title/subtitle/content. The
 * filename never changes, and `order` is read from the existing file and
 * preserved — this endpoint never assigns a new one.
 */
export async function updateWidget(
  root: string,
  dashboardId: string,
  id: string,
  input: WidgetContentInput,
): Promise<MarkdownWidget> {
  const filePath = widgetPath(root, dashboardId, id);
  const raw = await readOrThrowNotFound(filePath, id);
  const { data } = frontmatter.parse(raw);
  const order = typeof data.order === 'number' ? data.order : 0;

  const widget: MarkdownWidget = {
    id,
    type: 'markdown',
    title: input.title,
    subtitle: input.subtitle,
    order,
    content: input.content,
  };
  await writeWidgetFile(root, dashboardId, widget);
  return widget;
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

const SEED_WIDGETS: WidgetContentInput[] = [
  {
    title: 'Welcome',
    subtitle: 'Your AI Workspace',
    content:
      '# Welcome to Amazing Hashbrown\n\nThis is your central dashboard for all AI-powered features.',
  },
  {
    title: 'Getting Started',
    subtitle: 'A few things to try',
    content:
      '## Getting Started\n\n- Start a chat from the sidebar\n- Browse the **Wiki** for ingested knowledge\n- Check **Workspaces** for active projects\n- Visit **Settings** to configure providers and tools',
  },
  {
    title: 'Tip',
    content:
      'You can fork any thread to explore a different direction without losing the original.',
  },
  {
    title: "What's New",
    subtitle: 'Recent changes',
    content:
      '### Dashboard\n\nThis dashboard is new! More widget types and the ability to customize your layout are coming in future updates.',
  },
];

/**
 * If `<root>/<dashboardId>/` is missing or has no `.md` files, create it
 * and write the sample widgets as real files. A no-op otherwise.
 */
export async function ensureSeeded(root: string, dashboardId: string): Promise<void> {
  const dir = dashboardDir(root, dashboardId);
  const filenames = await listMarkdownFilenames(dir);
  if (filenames.length > 0) return;

  await fs.mkdir(dir, { recursive: true });
  for (let order = 0; order < SEED_WIDGETS.length; order++) {
    const seed = SEED_WIDGETS[order]!;
    const widget: MarkdownWidget = {
      id: slugify(seed.title) || `widget-${order}`,
      type: 'markdown',
      title: seed.title,
      subtitle: seed.subtitle,
      order,
      content: seed.content,
    };
    await writeWidgetFile(root, dashboardId, widget);
  }
}
