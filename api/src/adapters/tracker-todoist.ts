import type {
  Assignee,
  AuthField,
  CreateTrackerItemParams,
  TrackerAdapter,
  TrackerContainer,
  TrackerItem,
} from '../services/tracker-adapter.js';

// Todoist's unified API (v1), which replaced REST v2 and Sync v9.
// IDs are opaque alphanumeric strings; old numeric ids are rejected.
export const TODOIST_API = 'https://api.todoist.com/api/v1';

// Assignee Labels (GLOSSARY.md): every label starting with this prefix is
// owned by hashbrown; all other labels on an item belong to the user.
export const ASSIGNEE_LABEL_PREFIX = 'AH:';
export const ASSIGNEE_LABELS: Record<Exclude<Assignee, null>, string> = {
  user: 'AH:User',
  agent: 'AH:Agent',
};

// The completed-tasks endpoint only accepts a window of up to 3 months, so the
// fallback lookup for a completed task can only see that far back.
const COMPLETED_LOOKBACK_DAYS = 89;
const PAGE_LIMIT = 200;

// Accepts both https://app.todoist.com/app/task/{id} and the web app's
// slugged form https://app.todoist.com/app/task/{slug}-{id}; ids never
// contain hyphens, so the id is always the last hyphen-separated segment.
const TASK_URL_RE =
  /^https?:\/\/app\.todoist\.com\/app\/task\/(?:[^/?#]*-)?([A-Za-z0-9]+)\/?(?:[?#].*)?$/;

const TODOIST_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3"/><path d="M5 8.25 7 10.25 11 6"/></svg>';

const AUTH_SCHEMA: AuthField[] = [
  {
    key: 'token',
    label: 'API token',
    type: 'password',
    required: true,
    supportsEnvRef: true,
  },
];

interface TodoistDue {
  date: string; // YYYY-MM-DD, or a full datetime for tasks with a time
}

interface TodoistTask {
  id: string;
  content: string;
  labels?: string[];
  due?: TodoistDue | null;
}

interface TodoistPage<T> {
  results?: T[];
  items?: T[]; // the completed-tasks endpoints page under `items`
  next_cursor?: string | null;
}

interface TodoistProject {
  id: string;
  name: string;
}

interface TodoistLabel {
  id: string;
  name: string;
}

export class TodoistApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Todoist API error ${status}: ${body}`);
  }
}

export interface TodoistAdapterOptions {
  now?: () => Date; // injectable clock for the completed-task lookback window
}

function taskUrl(id: string): string {
  return `https://app.todoist.com/app/task/${id}`;
}

function toTrackerItem(task: TodoistTask, completed: boolean): TrackerItem {
  return {
    id: task.id,
    url: taskUrl(task.id),
    title: task.content,
    state: completed ? 'done' : 'pending',
    trackerState: completed ? 'completed' : 'active',
    dueAt: task.due?.date ? task.due.date.slice(0, 10) : null,
  };
}

export function createTodoistTrackerAdapter(
  token?: string,
  options: TodoistAdapterOptions = {},
): TrackerAdapter {
  const configured = Boolean(token);
  const now = options.now ?? (() => new Date());

  function requireConfigured(): void {
    if (!configured) throw new Error('Todoist adapter is not configured');
  }

  async function todoistFetch<T>(path: string, init: RequestInit = {}): Promise<T | undefined> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${TODOIST_API}${path}`, { ...init, headers });
    if (!res.ok) throw new TodoistApiError(res.status, await res.text());
    if (res.status === 204) return undefined;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : undefined;
  }

  async function walkPages<T>(path: string, key: 'results' | 'items'): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null | undefined;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const page = await todoistFetch<TodoistPage<T>>(
        `${path}${sep}limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      out.push(...(page?.[key] ?? []));
      cursor = page?.next_cursor;
    } while (cursor);
    return out;
  }

  // Returns null when the task isn't active (completed or deleted) — the
  // single-task endpoint only returns active tasks.
  async function fetchActiveTask(id: string): Promise<TodoistTask | null> {
    try {
      return (await todoistFetch<TodoistTask>(`/tasks/${encodeURIComponent(id)}`)) ?? null;
    } catch (err) {
      if (err instanceof TodoistApiError && err.status === 404) return null;
      throw err;
    }
  }

  async function findCompletedTask(id: string): Promise<TodoistTask | null> {
    const until = now();
    const since = new Date(until.getTime() - COMPLETED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const completed = await walkPages<TodoistTask>(
      `/tasks/completed/by_completion_date?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`,
      'items',
    );
    return completed.find((t) => t.id === id) ?? null;
  }

  async function ensureLabelExists(name: string): Promise<void> {
    const labels = await walkPages<TodoistLabel>('/labels', 'results');
    if (labels.some((l) => l.name === name)) return;
    await todoistFetch('/labels', { method: 'POST', body: JSON.stringify({ name }) });
  }

  return {
    type: 'todoist',
    displayName: 'Todoist',
    icon: TODOIST_ICON,
    authSchema: AUTH_SCHEMA,
    canCreate: configured,
    configured,

    async resolveUrl(url: string): Promise<TrackerItem> {
      const match = TASK_URL_RE.exec(url.trim());
      if (!match) throw new Error('Not a recognised Todoist task URL');
      requireConfigured();
      const task = await fetchActiveTask(match[1]!);
      if (!task) throw new Error("Todoist task is completed or doesn't exist");
      return toTrackerItem(task, false);
    },

    async getItem(id: string): Promise<TrackerItem> {
      requireConfigured();
      const active = await fetchActiveTask(id);
      if (active) return toTrackerItem(active, false);
      const completed = await findCompletedTask(id);
      if (completed) return toTrackerItem(completed, true);
      throw new Error(`Todoist task "${id}" not found (deleted, or completed over 3 months ago)`);
    },

    async createItem(params: CreateTrackerItemParams): Promise<TrackerItem> {
      requireConfigured();
      const body: Record<string, string> = { content: params.title };
      if (params.body) body['description'] = params.body;
      if (params.container) body['project_id'] = params.container;
      if (params.dueAt) body['due_date'] = params.dueAt;
      const task = await todoistFetch<TodoistTask>('/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!task) throw new Error('Todoist returned no task for create');
      return toTrackerItem(task, false);
    },

    async updateState(): Promise<TrackerItem> {
      throw new Error('updateState is not supported by the Todoist tracker adapter yet');
    },

    async listContainers(): Promise<TrackerContainer[]> {
      requireConfigured();
      const projects = await walkPages<TodoistProject>('/projects', 'results');
      return projects.map((p) => ({ id: p.id, name: p.name }));
    },

    async setAssignee(id: string, assignee: Assignee): Promise<void> {
      requireConfigured();
      const desired = assignee ? ASSIGNEE_LABELS[assignee] : null;
      const task = await fetchActiveTask(id);
      if (!task) return; // completed or deleted — nothing to label
      const current = task.labels ?? [];
      const next = current.filter((l) => !l.startsWith(ASSIGNEE_LABEL_PREFIX));
      if (desired) next.push(desired);
      const unchanged = next.length === current.length && next.every((l) => current.includes(l));
      if (unchanged) return;
      if (desired) await ensureLabelExists(desired);
      // Todoist replaces the whole label list on update, so the full list
      // (the user's own labels included) is always sent back.
      await todoistFetch(`/tasks/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({ labels: next }),
      });
    },
  };
}
