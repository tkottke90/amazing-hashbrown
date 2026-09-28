import { useEffect } from 'preact/hooks';
import { useSignal, useComputed } from '@preact/signals';
import { useLocation } from 'preact-iso';
import { ChevronRight, GitBranch, BookOpen, Calendar } from 'lucide-preact';

import { Layout } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { WorkspaceSettingsDrawer } from '@/pages/workspaces/workspace-settings-drawer';
import { FilesTab } from '@/pages/workspaces/files-tab';
import { WorkspaceChatTab } from '@/pages/workspaces/workspace-chat-tab';
import {
  workspaces,
  projects,
  refreshWorkspaces,
  deleteWorkspace,
  closeProject,
  getProjectForWorkspace,
} from '@/hooks/use-workspaces';
import { tasks, refreshTasks } from '@/hooks/use-tasks';
import { useIsWideBoardViewport } from '@/hooks/use-media-query';
import { TaskBoard } from '@/pages/workspaces/task-board/task-board';
import { TaskListMobile } from '@/pages/workspaces/task-board/task-list-mobile';
import { useTitle } from '@/hooks/use-title';
import { cn } from '@/lib/utils';
import type { Workspace, DirectoryRemovalResult } from '@/services/workspaces-api';
import { fetchGitStatus, type GitStatus } from '@/services/workspace-git-api';
import { showToast } from '@/lib/toast';
import { buildDeleteConfirmMessage } from '@/pages/workspaces/delete-confirm-message';

type DetailTab = 'overview' | 'tasks' | 'files' | 'chat';

const DETAIL_TAB_TITLE_SUFFIX: Record<DetailTab, string> = {
  overview: '',
  tasks: ' - Kanban',
  files: ' - Files',
  chat: ' - Chat',
};

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
          {workspace.wikiId ? (
            <a
              data-testid="wiki-link"
              href={`/wiki?view=document&domain=${encodeURIComponent(workspace.wikiId)}&page=index.md`}
              class="text-sm text-primary underline underline-offset-2"
            >
              {workspace.wikiId}
            </a>
          ) : (
            <p class="text-sm text-muted-foreground">Not linked</p>
          )}
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

function TasksTab({
  workspaceId,
  onSaved,
  onGoToChat,
}: {
  workspaceId: string;
  onSaved: () => void;
  onGoToChat: () => void;
}) {
  const workspaceTasks = useComputed(() =>
    tasks.value.filter((t) => t.workspaceId === workspaceId),
  );
  // All five lanes fit side by side from 1024px; narrower screens get the
  // grouped list with one-tap actions instead of drag-and-drop.
  const wide = useIsWideBoardViewport();

  return wide ? (
    <TaskBoard
      workspaceId={workspaceId}
      taskList={workspaceTasks.value}
      onSaved={onSaved}
      onGoToChat={onGoToChat}
    />
  ) : (
    <TaskListMobile
      workspaceId={workspaceId}
      taskList={workspaceTasks.value}
      onSaved={onSaved}
      onGoToChat={onGoToChat}
    />
  );
}

// path prop is consumed by preact-iso's Router for route matching
export function WorkspaceDetailView({ id }: { id?: string; path?: string }) {
  const { route } = useLocation();
  const { setPageTitle } = useTitle();
  const tab = useSignal<DetailTab>('overview');

  useEffect(() => {
    void refreshWorkspaces();
    if (id) void refreshTasks({ workspace_id: id });
  }, [id]);

  const workspace = useComputed(() => workspaces.value.find((w) => w.id === id));
  const proj = useComputed(() => (id ? getProjectForWorkspace(id) : undefined));
  const projectStatus = proj.value?.project.status;

  useEffect(() => {
    if (id && projectStatus === 'closing') {
      route(`/workspaces/${id}/close`);
    }
  }, [id, projectStatus]);

  useEffect(() => {
    if (!workspace.value) return;
    setPageTitle(`${workspace.value.name}${DETAIL_TAB_TITLE_SUFFIX[tab.value]}`);
  }, [workspace.value?.name, tab.value]);

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
  const isActive = !isProj || projectStatus === 'active';
  const isTerminal = projectStatus === 'closed' || projectStatus === 'abandoned';

  async function handleDelete() {
    // Only a managed directory is deleted, so only then does local-only git
    // work matter. A failed status check never blocks the delete — the
    // confirm just goes without the git warning.
    let gitStatus: GitStatus | null = null;
    if (ws.git && ws.managedLocation) {
      gitStatus = await fetchGitStatus(ws.id).catch(() => null);
    }
    if (!confirm(buildDeleteConfirmMessage(ws, gitStatus))) return;

    let directory: DirectoryRemovalResult;
    try {
      ({ directory } = await deleteWorkspace(ws.id));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to delete workspace');
      return;
    }
    if (!directory.removed) {
      const message =
        directory.reason === 'rm-failed'
          ? `Workspace deleted, but its directory could not be removed: ${directory.path}`
          : `Workspace deleted. Its directory was left on disk: ${directory.path}`;
      showToast('error', message, 10000);
    }
    route('/workspaces');
  }

  async function handleCloseIntent(intent: 'close' | 'abandon') {
    const verb = intent === 'close' ? 'Close' : 'Abandon';
    if (!confirm(`${verb} project "${ws.name}"?`)) return;
    await closeProject(ws.id, intent);
    route(`/workspaces/${ws.id}/close`);
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
              <span
                class={cn(
                  'size-2 rounded-full inline-block',
                  isTerminal ? 'bg-muted-foreground' : isActive ? 'bg-green-500' : 'bg-amber-500',
                )}
                title={isTerminal ? 'Closed' : isActive ? 'Active' : 'Closing'}
              />
            </div>

            <div class="flex items-center gap-2 shrink-0">
              {!isTerminal && (
                <WorkspaceSettingsDrawer workspace={ws} onSaved={() => void refreshWorkspaces()} />
              )}
              {isProj && projectStatus === 'active' && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleCloseIntent('close')}
                  >
                    Close project
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleCloseIntent('abandon')}
                  >
                    Abandon
                  </Button>
                </>
              )}
              <Button size="sm" variant="destructive" onClick={handleDelete}>
                Delete
              </Button>
            </div>
          </div>

          <div class="flex items-center gap-3 text-xs text-muted-foreground mb-3 flex-wrap">
            <span class="font-mono bg-muted px-1.5 py-0.5 rounded">{ws.location}</span>
            {ws.git && (
              <span
                class="flex items-center gap-1"
                data-testid="git-chip"
                title={ws.remoteUrl ?? undefined}
              >
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
            {ws.javascript && (
              <span class="flex items-center gap-1" data-testid="javascript-chip">
                <span class="inline-flex items-center justify-center size-4 rounded bg-primary text-primary-foreground text-[10px]">
                  ✓
                </span>
                JavaScript <span class="text-muted-foreground">(node_modules)</span>
              </span>
            )}
            {ws.python && (
              <span class="flex items-center gap-1" data-testid="python-chip">
                <span class="inline-flex items-center justify-center size-4 rounded bg-primary text-primary-foreground text-[10px]">
                  ✓
                </span>
                Python <span class="text-muted-foreground">(venv)</span>
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
              onGoToChat={() => {
                tab.value = 'chat';
              }}
            />
          )}
          {tab.value === 'files' && id && <FilesTab workspaceId={id} git={ws.git} />}
          {tab.value === 'chat' && <WorkspaceChatTab workspace={ws} />}
        </div>
      </div>
    </Layout>
  );
}
