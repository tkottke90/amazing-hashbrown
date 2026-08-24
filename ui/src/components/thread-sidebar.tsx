import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Copy,
  Trash2,
  Loader2,
  BookOpen,
  Cog,
  FileDown,
  Inbox,
  Folder,
  Circle,
} from 'lucide-preact';
import { useLocation } from 'preact-iso';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { AfterAgentIndicator } from '@/components/after-agent-indicator';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  threads,
  activeThreadId,
  refreshThreadList,
  newThread,
  renameThread,
  deleteThread,
  regenerateTitle,
  showErrorMessages,
  setShowErrorMessages,
  type ThreadSummary,
} from '@/hooks/use-thread';
import { queueState, refreshQueue } from '@/hooks/use-tasks';
import { fetchTasks } from '@/services/tasks-api';

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

interface ThreadRowProps {
  thread: ThreadSummary;
  isActive: boolean;
}

function ThreadRow({ thread, isActive }: ThreadRowProps) {
  const { route } = useLocation();
  const isEditing = useSignal(false);
  const isConfirmingDelete = useSignal(false);
  const isRegenerating = useSignal(false);
  const editValue = useSignal(thread.title);

  const sourceThread = thread.forkedFromThreadId
    ? threads.value.find((t) => t.id === thread.forkedFromThreadId)
    : undefined;

  async function commitRename() {
    const title = editValue.value.trim();
    isEditing.value = false;
    if (!title || title === thread.title) return;
    await renameThread(thread.id, title);
  }

  async function handleRegenerateTitle() {
    isRegenerating.value = true;
    try {
      await regenerateTitle(thread.id);
    } finally {
      isRegenerating.value = false;
    }
  }

  function handleCopyThreadId() {
    navigator.clipboard.writeText(thread.id).catch(() => {});
  }

  if (isEditing.value) {
    return (
      <div className="flex items-center gap-1 px-2 py-1">
        <Input
          autoFocus
          value={editValue.value}
          onInput={(e) => {
            editValue.value = (e.target as HTMLInputElement).value;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') {
              editValue.value = thread.title;
              isEditing.value = false;
            }
          }}
          onBlur={commitRename}
          className="h-7 text-sm"
        />
      </div>
    );
  }

  if (isConfirmingDelete.value) {
    return (
      <div className="flex items-center gap-1 rounded-md px-3 py-2 text-sm">
        <span className="flex-1 truncate text-muted-foreground">Delete this thread?</span>
        <Button
          size="xs"
          variant="destructive"
          onClick={() => deleteThread(thread.id)}
          aria-label="Confirm delete"
        >
          Delete
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            isConfirmingDelete.value = false;
          }}
          aria-label="Cancel delete"
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div
      data-slot="thread-row"
      data-active={isActive || undefined}
      className={cn(
        'group/thread-row flex items-center gap-1 rounded-md px-1 py-1 text-sm hover:bg-sidebar-accent',
        isActive && 'bg-sidebar-accent font-medium',
      )}
    >
      <button
        type="button"
        onClick={() => route(`/chat/${thread.id}`)}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1 text-left"
      >
        <span className="w-full truncate">{thread.title}</span>
        <span className="text-xs text-muted-foreground">
          {sourceThread
            ? `Forked from ${sourceThread.title}`
            : formatRelativeTime(thread.updatedAt)}
        </span>
      </button>

      {isRegenerating.value ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : thread.afterAgentState.status !== 'idle' ? (
        <AfterAgentIndicator state={thread.afterAgentState} className="shrink-0 px-1" />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Options for ${thread.title}`}
            className="shrink-0 rounded p-1 opacity-0 hover:bg-muted group-hover/thread-row:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={() => {
                editValue.value = thread.title;
                isEditing.value = true;
              }}
            >
              <Pencil className="size-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleRegenerateTitle}>
              <Sparkles className="size-4" />
              Regenerate title
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleCopyThreadId}>
              <Copy className="size-4" />
              Copy thread ID
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => window.open(`/api/v1/threads/${thread.id}/report`, '_blank')}
            >
              <FileDown className="size-4" />
              Generate thread report
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                isConfirmingDelete.value = true;
              }}
            >
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function QueueWidget() {
  const { running, paused, queue } = queueState.value;
  const pending = queue.filter((e) => e.status === 'pending').length;
  // While paused, a task that was running gets re-queued with status
  // 'paused' rather than staying in `running` — surface it as the current
  // task so the widget doesn't blank out mid-pause.
  const pausedEntry = queue.find((e) => e.status === 'paused');
  const currentTask = running?.task ?? pausedEntry?.task ?? queue[0]?.task ?? null;

  if (!currentTask && pending === 0) return null;

  return (
    <div
      data-testid="queue-widget"
      class="border border-border rounded-[10px] p-[10px_12px] bg-card mb-1"
    >
      <div class="flex items-center gap-1.5 mb-1">
        <Circle class={cn('size-[7px] fill-current', paused ? 'text-amber-500' : 'text-primary')} />
        <span class="text-[10px] font-semibold tracking-wider uppercase text-muted-foreground">
          Queue
        </span>
      </div>
      <div data-testid="queue-current-task" class="text-[12px] font-medium truncate">
        {currentTask?.title ?? '—'}
      </div>
      <div data-testid="queue-status" class="text-[11px] text-muted-foreground mt-0.5">
        {paused
          ? 'Paused — chat active · resumes 30 s after last response'
          : `running · ${pending} pending`}
      </div>
    </div>
  );
}

export function ThreadSidebar() {
  const { url, route } = useLocation();
  const inboxCount = useSignal(0);

  useEffect(() => {
    refreshThreadList();
    void refreshQueue();
    void Promise.all([
      fetchTasks({ workspace_id: null, status: 'pending' }),
      fetchTasks({ workspace_id: null, status: 'ready' }),
    ])
      .then(([pending, ready]) => {
        inboxCount.value = pending.length + ready.length;
      })
      .catch(() => {});

    const queueInterval = setInterval(() => void refreshQueue(), 10_000);
    return () => clearInterval(queueInterval);
  }, []);

  return (
    <nav className="flex h-full min-h-full flex-col gap-2 p-3">
      <Button
        variant="outline"
        className="justify-start gap-2"
        onClick={() => {
          const id = newThread();
          route(`/chat/${id}`);
        }}
        aria-label="New conversation"
      >
        <Plus className="size-4" />
        New conversation
      </Button>

      <div className="flex flex-1 flex-col gap-0.5">
        {threads.value.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            isActive={thread.id === activeThreadId.value}
          />
        ))}
      </div>

      <a
        href="/inbox"
        aria-label="Inbox"
        className={cn(
          'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
          url === '/inbox'
            ? 'bg-sidebar-accent font-medium text-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
        )}
      >
        <Inbox className="size-4 shrink-0" />
        <span class="flex-1">Inbox</span>
        {inboxCount.value > 0 && (
          <span class="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
            {inboxCount.value}
          </span>
        )}
      </a>
      <a
        href="/workspaces"
        aria-label="Workspaces"
        className={cn(
          'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
          url.startsWith('/workspaces')
            ? 'bg-sidebar-accent font-medium text-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
        )}
      >
        <Folder className="size-4 shrink-0" />
        Workspaces
      </a>
      <a
        href="/wiki"
        aria-label="Wiki"
        className={cn(
          'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
          url === '/wiki'
            ? 'bg-sidebar-accent font-medium text-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
        )}
      >
        <BookOpen className="size-4 shrink-0" />
        Wiki
      </a>
      <a
        href="/settings"
        aria-label="Settings"
        className={cn(
          'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
          url === '/settings'
            ? 'bg-sidebar-accent font-medium text-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
        )}
      >
        <Cog className="size-4 shrink-0" />
        Settings
      </a>

      <div class="border-t border-border pt-2 mt-1">
        <QueueWidget />
        <label className="flex items-center justify-between gap-2 px-2 pt-2 text-xs text-muted-foreground">
          <span>Show failed attempts</span>
          <Switch
            size="sm"
            checked={showErrorMessages.value}
            onCheckedChange={(checked) => setShowErrorMessages(checked === true)}
          />
        </label>
      </div>
    </nav>
  );
}
