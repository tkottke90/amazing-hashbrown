import { useEffect } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { useSignal, useComputed } from '@preact/signals';
import { useLocation } from 'preact-iso';
import { ChevronRight, Plus, GitBranch, BookOpen, Calendar } from 'lucide-preact';

import { Layout } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { TaskDrawer } from '@/components/task-drawer';
import { WorkspaceSettingsDrawer } from '@/components/workspace-settings-drawer';
import {
  workspaces,
  projects,
  refreshWorkspaces,
  deleteWorkspace,
  closeProject,
  getProjectForWorkspace,
} from '@/hooks/use-workspaces';
import { tasks, refreshTasks, groupTasksByStatus } from '@/hooks/use-tasks';
import { cn } from '@/lib/utils';
import type { Task, TaskStatus } from '@/services/tasks-api';
import type { Workspace } from '@/services/workspaces-api';

type DetailTab = 'overview' | 'tasks' | 'files' | 'chat';

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  ready: 'Ready',
  running: 'Running',
  waiting_on_user: 'Waiting on user',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const COLUMN_ORDER: TaskStatus[] = [
  'pending',
  'ready',
  'running',
  'waiting_on_user',
  'blocked',
  'done',
  'failed',
];

function KanbanColumn({
  status,
  taskList,
  workspaceId,
  onSaved,
}: {
  status: TaskStatus;
  taskList: Task[];
  workspaceId: string;
  onSaved: () => void;
}) {
  const isDone = status === 'done';
  const isReady = status === 'ready';
  const isRunning = status === 'running';
  const isBlocked = status === 'blocked';
  const isFailed = status === 'failed';
  const label = status === 'failed' ? 'Failed / Cancelled' : STATUS_LABELS[status];

  const columnTasks = status === 'failed' ? [...taskList] : taskList;

  return (
    <div data-column={status} class="bg-muted rounded-xl p-2.5 flex flex-col gap-2 min-h-[200px]">
      <div class="flex items-center justify-between px-1">
        <span
          class={cn(
            'text-xs font-semibold uppercase tracking-wider',
            isRunning
              ? 'text-primary'
              : isBlocked || isFailed
                ? 'text-destructive'
                : isDone
                  ? 'text-green-600'
                  : isReady
                    ? 'text-amber-600'
                    : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        <span class="rounded-full bg-background border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {columnTasks.length}
        </span>
      </div>

      {columnTasks.map((task) => (
        <TaskDrawer
          key={task.id}
          task={task}
          defaultWorkspaceId={workspaceId}
          onSaved={onSaved}
          trigger={<TaskCard task={task} />}
        />
      ))}
    </div>
  );
}

// forwardRef is required because preact/compat drops refs on plain function
// components (preactjs/preact#3297). Dialog.tsx clones the trigger element and
// attaches a ref to wire up the click→showModal handler; without forwardRef
// that ref is silently discarded and the drawer never opens.
const TaskCard = forwardRef<HTMLButtonElement, { task: Task }>(function TaskCard({ task }, ref) {
  const isRunning = task.status === 'running';
  const isDone = task.status === 'done';

  return (
    <button
      ref={ref}
      type="button"
      data-testid="task-card"
      data-task-id={task.id}
      class={cn(
        'bg-card border border-border rounded-[10px] p-[11px_12px] text-left text-sm transition-colors hover:border-primary/40 w-full',
        isRunning && 'border-primary',
        isDone && 'opacity-75',
      )}
    >
      <p class="font-medium truncate">{task.title}</p>
      {task.assignedTo && (
        <span
          class={cn(
            'inline-flex items-center mt-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
            task.assignedTo === 'agent'
              ? 'bg-primary/10 text-primary'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {task.assignedTo}
        </span>
      )}
      {task.dueAt && (
        <p class="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
          <Calendar class="size-3" />
          {new Date(task.dueAt).toLocaleDateString()}
        </p>
      )}
    </button>
  );
});

function OverviewTab({
  workspace,
  proj,
}: {
  workspace: Workspace;
  proj: ReturnType<typeof getProjectForWorkspace>;
}) {
  if (!proj) {
    return (
      <div class="p-4 flex flex-col gap-4">
        {workspace.goal && (
          <div class="border border-border rounded-xl p-4">
            <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Goal
            </p>
            <p class="text-sm">{workspace.goal}</p>
          </div>
        )}
        <p class="text-sm text-muted-foreground">{workspace.description ?? 'No description.'}</p>
      </div>
    );
  }

  return (
    <div class="p-4 flex flex-col gap-4">
      <div data-testid="win-condition" class="border border-primary/30 rounded-xl p-4 bg-primary/5">
        <p class="text-xs font-semibold text-primary uppercase tracking-wider mb-1">
          Win condition
        </p>
        <p class="text-sm">{proj.project.winCondition}</p>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="border border-border rounded-xl p-4">
          <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Status
          </p>
          <p class="text-sm capitalize">{proj.project.status}</p>
          {proj.project.dueAt && (
            <p class="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Calendar class="size-3" />
              Due {new Date(proj.project.dueAt).toLocaleDateString()}
            </p>
          )}
        </div>
        <div class="border border-border rounded-xl p-4">
          <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Wiki
          </p>
          <p class="text-sm">{workspace.wikiId ?? 'Not linked'}</p>
        </div>
      </div>

      {workspace.description && (
        <div class="border border-border rounded-xl p-4">
          <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Description
          </p>
          <p class="text-sm">{workspace.description}</p>
        </div>
      )}
    </div>
  );
}

function TasksTab({ workspaceId, onSaved }: { workspaceId: string; onSaved: () => void }) {
  const workspaceTasks = useComputed(() =>
    tasks.value.filter((t) => t.workspaceId === workspaceId),
  );
  const grouped = useComputed(() => groupTasksByStatus(workspaceTasks.value));

  const failedAndCancelled = useComputed(() => [
    ...grouped.value.failed,
    ...grouped.value.cancelled,
  ]);

  return (
    <div class="p-4">
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs text-muted-foreground">
          {workspaceTasks.value.length} total · queue is serial, one runs at a time
        </p>
        <TaskDrawer
          task={null}
          defaultWorkspaceId={workspaceId}
          onSaved={onSaved}
          trigger={
            <Button size="sm">
              <Plus class="size-3.5" />
              Add task
            </Button>
          }
        />
      </div>

      <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
        {COLUMN_ORDER.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            taskList={status === 'failed' ? failedAndCancelled.value : grouped.value[status]}
            workspaceId={workspaceId}
            onSaved={onSaved}
          />
        ))}
      </div>
    </div>
  );
}

// path prop is consumed by preact-iso's Router for route matching
export function WorkspaceDetailView({ id }: { id?: string; path?: string }) {
  const { route } = useLocation();
  const tab = useSignal<DetailTab>('overview');

  useEffect(() => {
    void refreshWorkspaces();
    if (id) void refreshTasks({ workspace_id: id });
  }, [id]);

  const workspace = useComputed(() => workspaces.value.find((w) => w.id === id));
  const proj = useComputed(() => (id ? getProjectForWorkspace(id) : undefined));

  if (!workspace.value) {
    return (
      <Layout>
        <div class="flex items-center justify-center h-full text-muted-foreground text-sm">
          Workspace not found.
        </div>
      </Layout>
    );
  }

  const ws = workspace.value;
  const isProj = !!proj.value;

  async function handleDelete() {
    if (!confirm(`Delete workspace "${ws.name}"? This cannot be undone.`)) return;
    await deleteWorkspace(ws.id);
    route('/workspaces');
  }

  async function handleClose() {
    if (!confirm(`Close project "${ws.name}"?`)) return;
    await closeProject(ws.id);
  }

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="px-6 pt-5 pb-0 border-b border-border">
          <nav class="flex items-center gap-1 text-xs text-muted-foreground mb-3">
            <a href="/workspaces" class="hover:text-foreground transition-colors">
              Workspaces
            </a>
            <ChevronRight class="size-3" />
            <span class="text-foreground font-medium">{ws.name}</span>
          </nav>

          <div class="flex items-start justify-between gap-4 mb-3">
            <div class="flex items-center gap-2 flex-wrap">
              <h1 class="text-lg font-semibold">{ws.name}</h1>
              {isProj && (
                <span class="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-semibold">
                  Project
                </span>
              )}
              <span class="size-2 rounded-full bg-green-500 inline-block" title="Active" />
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <WorkspaceSettingsDrawer workspace={ws} onSaved={() => void refreshWorkspaces()} />
              {isProj && proj.value?.project.status === 'active' && (
                <Button size="sm" variant="outline" onClick={handleClose}>
                  Close project
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={handleDelete}>
                Delete
              </Button>
            </div>
          </div>

          <div class="flex items-center gap-3 text-xs text-muted-foreground mb-3 flex-wrap">
            <span class="font-mono bg-muted px-1.5 py-0.5 rounded">{ws.location}</span>
            {ws.git && (
              <span class="flex items-center gap-1">
                <GitBranch class="size-3" />
                Git
              </span>
            )}
            {ws.wikiId && (
              <span class="flex items-center gap-1">
                <BookOpen class="size-3" />
                Wiki linked
              </span>
            )}
            {proj.value?.project.dueAt && (
              <span class="flex items-center gap-1">
                <Calendar class="size-3" />
                Due {new Date(proj.value.project.dueAt).toLocaleDateString()}
              </span>
            )}
          </div>

          <div class="flex items-center gap-1 -mb-px">
            {(['overview', 'tasks', 'files', 'chat'] as DetailTab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  tab.value = t;
                }}
                class={cn(
                  'px-3 py-2 text-sm capitalize border-b-2 transition-colors',
                  tab.value === t
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'tasks'
                  ? `Tasks (${tasks.value.filter((t) => t.workspaceId === id).length})`
                  : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto">
          {tab.value === 'overview' && <OverviewTab workspace={ws} proj={proj.value} />}
          {tab.value === 'tasks' && id && (
            <TasksTab
              workspaceId={id}
              onSaved={() => {
                if (id) void refreshTasks({ workspace_id: id });
              }}
            />
          )}
          {tab.value === 'files' && (
            <div class="p-4 text-sm text-muted-foreground">File browser coming soon.</div>
          )}
          {tab.value === 'chat' && (
            <div class="p-4 text-sm text-muted-foreground">Chat tab coming soon.</div>
          )}
        </div>
      </div>
    </Layout>
  );
}
