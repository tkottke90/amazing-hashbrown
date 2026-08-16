import { useEffect } from 'preact/hooks';
import { useSignal, useComputed } from '@preact/signals';
import { useLocation } from 'preact-iso';
import { Plus, FolderOpen, Search } from 'lucide-preact';

import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import { Layout } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  workspaces,
  projects,
  refreshWorkspaces,
  createWorkspace,
  createProject,
} from '@/hooks/use-workspaces';
import { tasks, refreshTasks } from '@/hooks/use-tasks';
import { cn } from '@/lib/utils';

type FilterTab = 'all' | 'workspaces' | 'projects' | 'closed';

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function isStale(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() > 7 * 86_400_000;
}

function CreateWorkspaceDrawer() {
  return (
    <Drawer
      title="New workspace"
      className="!p-0 !bg-background !rounded-none !border-0 border-l border-border"
      trigger={
        <Button variant="outline">
          <Plus class="size-4" />
          New workspace
        </Button>
      }
    >
      <CreateWorkspaceForm />
    </Drawer>
  );
}

function CreateWorkspaceForm() {
  const { close } = useDialog();
  const { route } = useLocation();
  const mode = useSignal<'workspace' | 'project'>('workspace');
  const name = useSignal('');
  const location = useSignal('');
  const goal = useSignal('');
  const winCondition = useSignal('');
  const dueAt = useSignal('');
  const saving = useSignal(false);
  const error = useSignal('');

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!name.value.trim() || !location.value.trim()) {
      error.value = 'Name and location are required.';
      return;
    }
    if (mode.value === 'project' && !winCondition.value.trim()) {
      error.value = 'Win condition is required for projects.';
      return;
    }
    saving.value = true;
    error.value = '';
    try {
      if (mode.value === 'project') {
        const entry = await createProject({
          name: name.value.trim(),
          location: location.value.trim(),
          goal: goal.value.trim() || null,
          winCondition: winCondition.value.trim(),
          dueAt: dueAt.value || null,
        });
        close();
        route(`/workspaces/${entry.id}`);
      } else {
        await createWorkspace({
          name: name.value.trim(),
          location: location.value.trim(),
          goal: goal.value.trim() || null,
        });
        close();
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to create.';
    } finally {
      saving.value = false;
    }
  }

  return (
    <div class="flex flex-col min-h-0 mt-2">
      <div class="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        <div class="flex items-center gap-1 border border-border rounded-lg overflow-hidden w-fit text-sm">
          <button
            type="button"
            onClick={() => {
              mode.value = 'workspace';
            }}
            class={cn(
              'px-3 py-1.5 transition-colors',
              mode.value === 'workspace'
                ? 'bg-muted font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Workspace
          </button>
          <button
            type="button"
            onClick={() => {
              mode.value = 'project';
            }}
            class={cn(
              'px-3 py-1.5 transition-colors',
              mode.value === 'project'
                ? 'bg-muted font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Project
          </button>
        </div>

        <form id="create-workspace-form" onSubmit={handleSubmit} class="flex flex-col gap-4">
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium text-muted-foreground">Name</label>
              <Input
                autoFocus
                placeholder="my-workspace"
                value={name.value}
                onInput={(e) => {
                  name.value = (e.target as HTMLInputElement).value;
                }}
                required
              />
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium text-muted-foreground">Location</label>
              <Input
                placeholder="/home/user/projects/my-workspace"
                value={location.value}
                onInput={(e) => {
                  location.value = (e.target as HTMLInputElement).value;
                }}
                required
              />
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-xs font-medium text-muted-foreground">Goal</label>
            <textarea
              placeholder="What should be accomplished in this workspace?"
              value={goal.value}
              onInput={(e) => {
                goal.value = (e.target as HTMLTextAreaElement).value;
              }}
              class="border border-input rounded-lg px-3 py-2 text-sm resize-none h-16 bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
            />
          </div>

          {mode.value === 'project' && (
            <div class="border border-primary/30 rounded-lg p-3 bg-primary/5 flex flex-col gap-3">
              <p class="text-xs font-semibold text-primary uppercase tracking-wider">
                Project fields
              </p>
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium text-muted-foreground">
                  Win condition <span class="text-destructive">*</span>
                </label>
                <textarea
                  placeholder="The project is done when..."
                  value={winCondition.value}
                  onInput={(e) => {
                    winCondition.value = (e.target as HTMLTextAreaElement).value;
                  }}
                  required
                  class="border border-input rounded-lg px-3 py-2 text-sm resize-none h-16 bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
                />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium text-muted-foreground">Due date</label>
                <Input
                  type="date"
                  value={dueAt.value}
                  onInput={(e) => {
                    dueAt.value = (e.target as HTMLInputElement).value;
                  }}
                />
              </div>
            </div>
          )}

          {error.value && <p class="text-sm text-destructive">{error.value}</p>}
        </form>
      </div>

      <div class="flex items-center gap-2 px-5 py-4 border-t border-border shrink-0 justify-end">
        <Button type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" form="create-workspace-form" disabled={saving.value}>
          {saving.value
            ? 'Creating…'
            : mode.value === 'project'
              ? 'Create project'
              : 'Create workspace'}
        </Button>
      </div>
    </div>
  );
}

// path prop is consumed by preact-iso's Router for route matching
export function WorkspacesView(_props: { path?: string }) {
  const filter = useSignal<FilterTab>('all');
  const search = useSignal('');

  useEffect(() => {
    void refreshWorkspaces();
    void refreshTasks({});
  }, []);

  const allWorkspaces = useComputed(() => {
    const projectIds = new Set(projects.value.map((p) => p.id));
    const closedIds = new Set(
      projects.value.filter((p) => p.project.status !== 'active').map((p) => p.id),
    );

    return workspaces.value.filter((ws) => {
      const q = search.value.toLowerCase();
      if (q && !ws.name.toLowerCase().includes(q)) return false;

      if (filter.value === 'workspaces') return !projectIds.has(ws.id);
      if (filter.value === 'projects') return projectIds.has(ws.id) && !closedIds.has(ws.id);
      if (filter.value === 'closed') return closedIds.has(ws.id);
      return true;
    });
  });

  const taskCountMap = useComputed(() => {
    const map: Record<string, number> = {};
    for (const t of tasks.value) {
      if (t.workspaceId) map[t.workspaceId] = (map[t.workspaceId] ?? 0) + 1;
    }
    return map;
  });

  const inboxTasks = useComputed(() => tasks.value.filter((t) => !t.workspaceId));

  const totalCount = workspaces.value.length;
  const projectCount = projects.value.length;

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="px-6 pt-6 pb-4">
          <div class="flex items-start justify-between gap-4 mb-4">
            <div>
              <h1 class="text-xl font-semibold">Workspaces</h1>
              <p class="text-sm text-muted-foreground mt-0.5">
                {totalCount} workspace{totalCount !== 1 ? 's' : ''} · {projectCount} are projects
              </p>
            </div>
            <div class="flex items-center gap-2">
              <CreateWorkspaceDrawer />
            </div>
          </div>

          <div class="flex items-center gap-3 mb-4">
            <div class="flex items-center gap-1 border border-border rounded-lg overflow-hidden text-sm">
              {(['all', 'workspaces', 'projects', 'closed'] as FilterTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    filter.value = tab;
                  }}
                  class={cn(
                    'px-3 py-1.5 capitalize transition-colors',
                    filter.value === tab
                      ? 'bg-muted font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div class="relative ml-auto">
              <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search"
                value={search.value}
                onInput={(e) => {
                  search.value = (e.target as HTMLInputElement).value;
                }}
                class="pl-8 w-52"
              />
            </div>
          </div>

          <div class="border border-border rounded-xl overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border bg-muted/40">
                  <th
                    class="px-4 py-2.5 text-left font-medium text-muted-foreground"
                    style="width:2.2fr"
                  >
                    Name
                  </th>
                  <th
                    class="px-4 py-2.5 text-left font-medium text-muted-foreground"
                    style="width:3fr"
                  >
                    Goal
                  </th>
                  <th
                    class="px-4 py-2.5 text-left font-medium text-muted-foreground"
                    style="width:0.7fr"
                  >
                    Git
                  </th>
                  <th
                    class="px-4 py-2.5 text-left font-medium text-muted-foreground"
                    style="width:0.8fr"
                  >
                    Tasks
                  </th>
                  <th
                    class="px-4 py-2.5 text-left font-medium text-muted-foreground"
                    style="width:1fr"
                  >
                    Last change
                  </th>
                </tr>
              </thead>
              <tbody>
                {allWorkspaces.value.length === 0 && (
                  <tr>
                    <td colspan={5} class="px-4 py-10 text-center text-muted-foreground">
                      <FolderOpen class="size-8 mx-auto mb-2 opacity-40" />
                      No workspaces yet
                    </td>
                  </tr>
                )}
                {allWorkspaces.value.map((ws) => {
                  const proj = projects.value.find((p) => p.id === ws.id);
                  const isClosed = proj?.project.status !== 'active';
                  const stale = isStale(ws.lastChange);
                  return (
                    <tr
                      key={ws.id}
                      class={cn(
                        'border-b border-border last:border-0 hover:bg-muted/30 transition-colors',
                        stale && 'opacity-60',
                      )}
                    >
                      <td class="px-4 py-3">
                        <a href={`/workspaces/${ws.id}`} class="font-medium hover:underline">
                          {ws.name}
                        </a>
                        {proj && (
                          <span
                            class={cn(
                              'ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                              isClosed
                                ? 'bg-muted text-muted-foreground'
                                : 'bg-primary/10 text-primary',
                            )}
                          >
                            {isClosed ? 'Project · closed' : 'Project'}
                          </span>
                        )}
                      </td>
                      <td class="px-4 py-3 text-muted-foreground truncate max-w-xs">
                        {ws.goal ?? '—'}
                      </td>
                      <td class="px-4 py-3">
                        {ws.git ? (
                          <span class="text-green-600 text-xs font-medium">Yes</span>
                        ) : (
                          <span class="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td class="px-4 py-3 text-muted-foreground">
                        {taskCountMap.value[ws.id] ?? 0}
                      </td>
                      <td
                        class={cn(
                          'px-4 py-3 text-xs',
                          stale ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        {formatRelativeTime(ws.lastChange)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {inboxTasks.value.length > 0 && (
            <div class="mt-6">
              <h2 class="text-sm font-semibold mb-3">
                Inbox{' '}
                <span class="text-muted-foreground font-normal">
                  ({inboxTasks.value.length} unassigned task
                  {inboxTasks.value.length !== 1 ? 's' : ''})
                </span>
              </h2>
              <div class="border border-border rounded-xl overflow-hidden">
                <table class="w-full text-sm">
                  <tbody>
                    {inboxTasks.value.map((task) => (
                      <tr
                        key={task.id}
                        class="border-b border-border last:border-0 hover:bg-muted/30"
                      >
                        <td class="px-4 py-3 font-medium">{task.title}</td>
                        <td class="px-4 py-3 text-muted-foreground capitalize">{task.status}</td>
                        <td class="px-4 py-3 text-muted-foreground">{task.assignedTo ?? '—'}</td>
                        <td class="px-4 py-3 text-xs text-muted-foreground">
                          {task.dueAt ? new Date(task.dueAt).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
