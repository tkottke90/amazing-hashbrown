import { randomUUID } from 'node:crypto';
import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspaceStatus = 'active' | 'closed' | 'abandoned';

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  goal: string | null;
  location: string;
  remoteUrl: string | null;
  javascript: boolean;
  python: boolean;
  git: boolean;
  wikiId: string | null;
  systemPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  lastChange: string;
}

export interface NewWorkspaceInput {
  name: string;
  description?: string | null;
  goal?: string | null;
  location: string;
  remoteUrl?: string | null;
  javascript?: boolean;
  python?: boolean;
  git?: boolean;
  wikiId?: string | null;
  systemPrompt?: string | null;
}

export interface PatchWorkspaceInput {
  name?: string;
  description?: string | null;
  goal?: string | null;
  remoteUrl?: string | null;
  javascript?: boolean;
  python?: boolean;
  git?: boolean;
  wikiId?: string | null;
  systemPrompt?: string | null;
}

export interface Project {
  id: string;
  workspaceId: string;
  winCondition: string;
  dueAt: string | null;
  status: 'active' | 'closed' | 'abandoned';
  closedAt: string | null;
}

export interface NewProjectInput extends NewWorkspaceInput {
  winCondition: string;
  dueAt?: string | null;
}

export interface PatchProjectInput extends PatchWorkspaceInput {
  winCondition?: string;
  dueAt?: string | null;
}

export type TaskStatus =
  'pending' | 'running' | 'waiting_on_user' | 'blocked' | 'done' | 'failed' | 'cancelled';

export type TriggerType = 'manual' | 'chat' | 'cron_once' | 'cron_repeat' | 'webhook';

export interface PlanStep {
  step: string;
  done: boolean;
}

export interface Task {
  id: string;
  workspaceId: string | null;
  title: string;
  description: string | null;
  outcome: string | null;
  status: TaskStatus;
  assignedTo: 'user' | 'agent' | null;
  dueAt: string | null;
  expiresAt: string | null;
  triggerType: TriggerType;
  triggerConfig: unknown | null;
  trackerType: string | null;
  trackerId: string | null;
  plan: PlanStep[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTaskInput {
  workspaceId?: string | null;
  title: string;
  description?: string | null;
  outcome?: string | null;
  assignedTo?: 'user' | 'agent' | null;
  dueAt?: string | null;
  expiresAt?: string | null;
  triggerType?: TriggerType;
  triggerConfig?: unknown | null;
  trackerType?: string | null;
  trackerId?: string | null;
  plan?: PlanStep[] | null;
}

export interface PatchTaskInput {
  workspaceId?: string | null;
  title?: string;
  description?: string | null;
  outcome?: string | null;
  status?: TaskStatus;
  assignedTo?: 'user' | 'agent' | null;
  dueAt?: string | null;
  expiresAt?: string | null;
  triggerType?: TriggerType;
  triggerConfig?: unknown | null;
  trackerType?: string | null;
  trackerId?: string | null;
  plan?: PlanStep[] | null;
}

export interface TaskQueueEntry {
  id: string;
  taskId: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed';
  position: number;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskListFilters {
  workspaceId?: string | null;
  status?: TaskStatus;
}

// ---------------------------------------------------------------------------
// Raw DB row interfaces
// ---------------------------------------------------------------------------

interface RawWorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  goal: string | null;
  location: string;
  remote_url: string | null;
  javascript: number;
  python: number;
  git: number;
  wiki_id: string | null;
  system_prompt: string | null;
  created_at: string;
  updated_at: string;
  last_change: string;
}

interface RawProjectRow {
  id: string;
  workspace_id: string;
  win_condition: string;
  due_at: string | null;
  status: 'active' | 'closed' | 'abandoned';
  closed_at: string | null;
}

interface RawTaskRow {
  id: string;
  workspace_id: string | null;
  title: string;
  description: string | null;
  outcome: string | null;
  status: TaskStatus;
  assigned_to: 'user' | 'agent' | null;
  due_at: string | null;
  expires_at: string | null;
  trigger_type: TriggerType;
  trigger_config: string | null;
  tracker_type: string | null;
  tracker_id: string | null;
  plan: string | null;
  created_at: string;
  updated_at: string;
}

interface RawQueueRow {
  id: string;
  task_id: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed';
  position: number;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

// ---------------------------------------------------------------------------
// Row <-> record mapping
// ---------------------------------------------------------------------------

function mapWorkspace(row: RawWorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    goal: row.goal,
    location: row.location,
    remoteUrl: row.remote_url,
    javascript: row.javascript === 1,
    python: row.python === 1,
    git: row.git === 1,
    wikiId: row.wiki_id,
    systemPrompt: row.system_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastChange: row.last_change,
  };
}

function mapProject(row: RawProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    winCondition: row.win_condition,
    dueAt: row.due_at,
    status: row.status,
    closedAt: row.closed_at,
  };
}

function mapTask(row: RawTaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    outcome: row.outcome,
    status: row.status,
    assignedTo: row.assigned_to,
    dueAt: row.due_at,
    expiresAt: row.expires_at,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config ? (JSON.parse(row.trigger_config) as unknown) : null,
    trackerType: row.tracker_type,
    trackerId: row.tracker_id,
    plan: row.plan ? (JSON.parse(row.plan) as PlanStep[]) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapQueueEntry(row: RawQueueRow): TaskQueueEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    position: row.position,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

// ---------------------------------------------------------------------------
// DDL migrations
// ---------------------------------------------------------------------------

// Version numbers must be unique across ALL stores sharing this database.
// 1=observability, 2=cost-store, 3=evaluations, 4=threads, 5=observability,
// 6=evaluations (judge_calibrations), 7=observability, 8=evaluations,
// 9=(free), 10-12=threads (type column), 13-16=threads (provider/model columns),
// 17=shell_audit_log. Versions 18-21 are claimed by WorkspaceStore here.
const MIGRATIONS: DbMigration[] = [
  {
    version: 18,
    sql: `
      CREATE TABLE IF NOT EXISTS workspaces (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT,
        goal          TEXT,
        location      TEXT NOT NULL,
        remote_url    TEXT,
        javascript    INTEGER NOT NULL DEFAULT 0,
        python        INTEGER NOT NULL DEFAULT 0,
        git           INTEGER NOT NULL DEFAULT 0,
        wiki_id       TEXT,
        system_prompt TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        last_change   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspaces_updated ON workspaces(updated_at);
    `,
  },
  {
    version: 19,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
        win_condition TEXT NOT NULL,
        due_at        TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        closed_at     TEXT
      );
    `,
  },
  {
    version: 20,
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT REFERENCES workspaces(id),
        title          TEXT NOT NULL,
        description    TEXT,
        outcome        TEXT,
        status         TEXT NOT NULL DEFAULT 'pending',
        assigned_to    TEXT,
        due_at         TEXT,
        expires_at     TEXT,
        trigger_type   TEXT NOT NULL DEFAULT 'manual',
        trigger_config TEXT,
        tracker_type   TEXT,
        tracker_id     TEXT,
        plan           TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `,
  },
  {
    version: 21,
    sql: `
      CREATE TABLE IF NOT EXISTS task_queue (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL REFERENCES tasks(id),
        status       TEXT NOT NULL DEFAULT 'pending',
        position     INTEGER NOT NULL,
        enqueued_at  TEXT NOT NULL,
        started_at   TEXT,
        finished_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_queue_status_position ON task_queue(status, position);
    `,
  },
];

// ---------------------------------------------------------------------------
// WorkspaceStore
// ---------------------------------------------------------------------------

export class WorkspaceStore extends BaseStore {
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
    this.recoverRunningQueueEntries();
  }

  // On server start, any queue entry stuck in `running` (from a crash) is
  // reset to `pending` so the scheduler can pick it up again (R5).
  private recoverRunningQueueEntries(): void {
    this.db
      .prepare(
        `UPDATE task_queue SET status = 'pending', started_at = NULL WHERE status = 'running'`,
      )
      .run();
  }

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare(`SELECT * FROM workspaces ORDER BY updated_at DESC`)
      .all() as RawWorkspaceRow[];
    return rows.map(mapWorkspace);
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(id) as
      RawWorkspaceRow | undefined;
    return row ? mapWorkspace(row) : null;
  }

  createWorkspace(input: NewWorkspaceInput): Workspace {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspaces
           (id, name, description, goal, location, remote_url, javascript, python, git, wiki_id, system_prompt, created_at, updated_at, last_change)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? null,
        input.goal ?? null,
        input.location,
        input.remoteUrl ?? null,
        input.javascript ? 1 : 0,
        input.python ? 1 : 0,
        input.git ? 1 : 0,
        input.wikiId ?? null,
        input.systemPrompt ?? null,
        now,
        now,
        now,
      );
    return this.getWorkspace(id)!;
  }

  patchWorkspace(id: string, patch: PatchWorkspaceInput): Workspace | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      values.push(patch.description);
    }
    if (patch.goal !== undefined) {
      sets.push('goal = ?');
      values.push(patch.goal);
    }
    if (patch.remoteUrl !== undefined) {
      sets.push('remote_url = ?');
      values.push(patch.remoteUrl);
    }
    if (patch.javascript !== undefined) {
      sets.push('javascript = ?');
      values.push(patch.javascript ? 1 : 0);
    }
    if (patch.python !== undefined) {
      sets.push('python = ?');
      values.push(patch.python ? 1 : 0);
    }
    if (patch.git !== undefined) {
      sets.push('git = ?');
      values.push(patch.git ? 1 : 0);
    }
    if (patch.wikiId !== undefined) {
      sets.push('wiki_id = ?');
      values.push(patch.wikiId);
    }
    if (patch.systemPrompt !== undefined) {
      sets.push('system_prompt = ?');
      values.push(patch.systemPrompt);
    }

    if (sets.length === 0) return this.getWorkspace(id);

    const now = new Date().toISOString();
    sets.push('updated_at = ?');
    values.push(now);

    const result = this.db
      .prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id);
    if (result.changes === 0) return null;
    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): boolean {
    const doDelete = this.db.transaction(() => {
      // Remove task_queue entries, then tasks, then the project row (all FK'd to this workspace).
      this.db
        .prepare(`DELETE FROM task_queue WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id = ?)`)
        .run(id);
      this.db.prepare(`DELETE FROM tasks WHERE workspace_id = ?`).run(id);
      this.db.prepare(`DELETE FROM projects WHERE workspace_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
    });
    const result = doDelete();
    return result.changes > 0;
  }

  touchWorkspace(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE workspaces SET last_change = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  listProjects(): Array<Workspace & { project: Project }> {
    const workspaces = this.db
      .prepare(
        `SELECT w.*, p.win_condition, p.due_at AS p_due_at, p.status AS p_status, p.closed_at
         FROM workspaces w
         INNER JOIN projects p ON p.workspace_id = w.id
         ORDER BY w.updated_at DESC`,
      )
      .all() as Array<
      RawWorkspaceRow & {
        win_condition: string;
        p_due_at: string | null;
        p_status: 'active' | 'closed' | 'abandoned';
        closed_at: string | null;
      }
    >;

    return workspaces.map((row) => ({
      ...mapWorkspace(row),
      project: {
        id: row.id,
        workspaceId: row.id,
        winCondition: row.win_condition,
        dueAt: row.p_due_at,
        status: row.p_status,
        closedAt: row.closed_at,
      },
    }));
  }

  getProject(workspaceId: string): Project | null {
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE workspace_id = ?`)
      .get(workspaceId) as RawProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  // Creates workspace + project rows in a single transaction (R1).
  createProject(input: NewProjectInput): { workspace: Workspace; project: Project } {
    const id = randomUUID();
    const now = new Date().toISOString();

    const doCreate = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspaces
             (id, name, description, goal, location, remote_url, javascript, python, git, wiki_id, system_prompt, created_at, updated_at, last_change)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.description ?? null,
          input.goal ?? null,
          input.location,
          input.remoteUrl ?? null,
          input.javascript ? 1 : 0,
          input.python ? 1 : 0,
          input.git ? 1 : 0,
          input.wikiId ?? null,
          input.systemPrompt ?? null,
          now,
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO projects (id, workspace_id, win_condition, due_at, status)
           VALUES (?, ?, ?, ?, 'active')`,
        )
        .run(id, id, input.winCondition, input.dueAt ?? null);
    });

    doCreate();

    return {
      workspace: this.getWorkspace(id)!,
      project: this.getProject(id)!,
    };
  }

  patchProject(workspaceId: string, patch: PatchProjectInput): Project | null {
    this.patchWorkspace(workspaceId, patch);

    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.winCondition !== undefined) {
      sets.push('win_condition = ?');
      values.push(patch.winCondition);
    }
    if (patch.dueAt !== undefined) {
      sets.push('due_at = ?');
      values.push(patch.dueAt);
    }

    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE workspace_id = ?`)
        .run(...values, workspaceId);
    }

    return this.getProject(workspaceId);
  }

  closeProject(workspaceId: string): Project | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE projects SET status = 'closed', closed_at = ? WHERE workspace_id = ? AND status = 'active'`,
      )
      .run(now, workspaceId);
    if (result.changes === 0) return null;
    return this.getProject(workspaceId);
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  listTasks(filters: TaskListFilters = {}): Task[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if ('workspaceId' in filters) {
      if (filters.workspaceId === null) {
        conditions.push('workspace_id IS NULL');
      } else if (filters.workspaceId !== undefined) {
        conditions.push('workspace_id = ?');
        values.push(filters.workspaceId);
      }
    }

    if (filters.status !== undefined) {
      conditions.push('status = ?');
      values.push(filters.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`)
      .all(...values) as RawTaskRow[];
    return rows.map(mapTask);
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
      RawTaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  createTask(input: NewTaskInput): Task {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, workspace_id, title, description, outcome, status, assigned_to, due_at, expires_at, trigger_type, trigger_config, tracker_type, tracker_id, plan, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId ?? null,
        input.title,
        input.description ?? null,
        input.outcome ?? null,
        input.assignedTo ?? null,
        input.dueAt ?? null,
        input.expiresAt ?? null,
        input.triggerType ?? 'manual',
        input.triggerConfig !== undefined ? JSON.stringify(input.triggerConfig) : null,
        input.trackerType ?? null,
        input.trackerId ?? null,
        input.plan ? JSON.stringify(input.plan) : null,
        now,
        now,
      );
    return this.getTask(id)!;
  }

  patchTask(id: string, patch: PatchTaskInput): Task | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.workspaceId !== undefined) {
      sets.push('workspace_id = ?');
      values.push(patch.workspaceId);
    }
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      values.push(patch.description);
    }
    if (patch.outcome !== undefined) {
      sets.push('outcome = ?');
      values.push(patch.outcome);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.assignedTo !== undefined) {
      sets.push('assigned_to = ?');
      values.push(patch.assignedTo);
    }
    if (patch.dueAt !== undefined) {
      sets.push('due_at = ?');
      values.push(patch.dueAt);
    }
    if (patch.expiresAt !== undefined) {
      sets.push('expires_at = ?');
      values.push(patch.expiresAt);
    }
    if (patch.triggerType !== undefined) {
      sets.push('trigger_type = ?');
      values.push(patch.triggerType);
    }
    if (patch.triggerConfig !== undefined) {
      sets.push('trigger_config = ?');
      values.push(JSON.stringify(patch.triggerConfig));
    }
    if (patch.trackerType !== undefined) {
      sets.push('tracker_type = ?');
      values.push(patch.trackerType);
    }
    if (patch.trackerId !== undefined) {
      sets.push('tracker_id = ?');
      values.push(patch.trackerId);
    }
    if (patch.plan !== undefined) {
      sets.push('plan = ?');
      values.push(patch.plan ? JSON.stringify(patch.plan) : null);
    }

    if (sets.length === 0) return this.getTask(id);

    const now = new Date().toISOString();
    sets.push('updated_at = ?');
    values.push(now);

    const result = this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id);
    if (result.changes === 0) return null;
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Task queue
  // -------------------------------------------------------------------------

  listQueue(): TaskQueueEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_queue WHERE status IN ('pending', 'running', 'paused') ORDER BY position ASC`,
      )
      .all() as RawQueueRow[];
    return rows.map(mapQueueEntry);
  }

  enqueueTask(taskId: string): TaskQueueEntry {
    const id = randomUUID();
    const now = new Date().toISOString();
    const posRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM task_queue WHERE status IN ('pending', 'running', 'paused')`,
      )
      .get() as { next: number };
    const position = posRow.next;

    this.db
      .prepare(
        `INSERT INTO task_queue (id, task_id, status, position, enqueued_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(id, taskId, position, now);

    const row = this.db.prepare(`SELECT * FROM task_queue WHERE id = ?`).get(id) as RawQueueRow;
    return mapQueueEntry(row);
  }

  dequeueNext(): (TaskQueueEntry & { task: Task }) | null {
    const row = this.db
      .prepare(`SELECT * FROM task_queue WHERE status = 'pending' ORDER BY position ASC LIMIT 1`)
      .get() as RawQueueRow | undefined;
    if (!row) return null;

    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE task_queue SET status = 'running', started_at = ? WHERE id = ?`)
      .run(now, row.id);
    this.db
      .prepare(`UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`)
      .run(now, row.task_id);

    const task = this.getTask(row.task_id);
    if (!task) return null;

    return { ...mapQueueEntry({ ...row, status: 'running', started_at: now }), task };
  }

  completeQueueEntry(id: string, outcome: 'done' | 'failed'): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE task_queue SET status = ?, finished_at = ? WHERE id = ?`)
      .run(outcome, now, id);

    const entry = this.db.prepare(`SELECT task_id FROM task_queue WHERE id = ?`).get(id) as
      { task_id: string } | undefined;
    if (entry) {
      this.db
        .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`)
        .run(outcome, now, entry.task_id);
    }
  }

  pauseQueueEntry(id: string): void {
    this.db.prepare(`UPDATE task_queue SET status = 'paused' WHERE id = ?`).run(id);
  }

  resumePausedEntry(id: string): void {
    this.db.prepare(`UPDATE task_queue SET status = 'pending' WHERE id = ?`).run(id);
  }

  getRunningEntry(): (TaskQueueEntry & { task: Task }) | null {
    const row = this.db
      .prepare(`SELECT * FROM task_queue WHERE status = 'running' LIMIT 1`)
      .get() as RawQueueRow | undefined;
    if (!row) return null;
    const task = this.getTask(row.task_id);
    if (!task) return null;
    return { ...mapQueueEntry(row), task };
  }
}

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

let _store: WorkspaceStore | null = null;

export function bootWorkspaceStore(db: SqliteDatabase): void {
  _store = new WorkspaceStore(db);
  logger.info('Workspace store opened');
}

export function getWorkspaceStore(): WorkspaceStore {
  if (!_store) throw new Error('Workspace store not initialised — call bootWorkspaceStore() first');
  return _store;
}
