import { useComputed, useSignal } from '@preact/signals';
import { BottomSheet } from '@tkottke90/preact-dialog';
import { ChevronDown, ChevronRight, Plus } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TaskDrawer, type TaskDraft } from '@/components/task-drawer';
import { findMove, performMove, requestMove } from '@/components/task-board/board-move';
import { ReplyForm } from '@/components/task-board/reply-form';
import { createTask, queueState } from '@/hooks/use-tasks';
import { showToast } from '@/lib/toast';
import { readJson, writeJson } from '@/utils/local-storage';
import type { Task } from '@/services/tasks-api';
import { BoardCard } from './board-card';
import { tasksByLane } from './lanes';

export type MobileSection = 'needs_you' | 'running' | 'up_next' | 'scheduled' | 'finished';

const SECTION_ORDER: readonly MobileSection[] = [
  'needs_you',
  'running',
  'up_next',
  'scheduled',
  'finished',
];

const SECTION_LABELS: Record<MobileSection, string> = {
  needs_you: 'Needs you',
  running: 'Running',
  up_next: 'Up next',
  scheduled: 'Scheduled',
  finished: 'Finished',
};

export const COLLAPSE_STORAGE_KEY = 'task-list-mobile:collapsed';
const DEFAULT_COLLAPSED: Partial<Record<MobileSection, boolean>> = { finished: true };

// The mobile list's sections, ordered by urgency, built from the server's
// lanes: Running is split out of the Queue, and Up next is the rest of the
// Queue (in run order) followed by the Backlog.
export function mobileSections(
  taskList: Task[],
  queue: Parameters<typeof tasksByLane>[1],
): Record<MobileSection, Task[]> {
  const lanes = tasksByLane(taskList, queue);
  return {
    needs_you: lanes.attention,
    running: lanes.queue.filter((t) => t.status === 'running'),
    up_next: [...lanes.queue.filter((t) => t.status !== 'running'), ...lanes.backlog],
    scheduled: lanes.scheduled,
    finished: lanes.done,
  };
}

// The one-tap action a card offers, if its move is allowed right now.
function PrimaryAction({ task, onReply }: { task: Task; onReply: (task: Task) => void }) {
  const reason = task.board?.reason;
  let label: string | null = null;
  let testId = '';
  if (reason?.kind === 'waiting_on_user') [label, testId] = ['Reply', 'card-action-reply'];
  else if (reason?.kind === 'failed') [label, testId] = ['Retry', 'card-action-retry'];
  else if (reason?.kind === 'paused') [label, testId] = ['Mark unblocked', 'card-action-unblock'];
  else if (task.board?.lane === 'scheduled') [label, testId] = ['Run now', 'card-action-run-now'];
  if (!label || !findMove(task, 'queue')) return null;

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      data-testid={testId}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        requestMove(task, 'queue', { onReply, successMessage: `Queued: ${task.title}` });
      }}
    >
      {label}
    </Button>
  );
}

function QuickAddForm({
  workspaceId,
  onDone,
  onMoreDetails,
}: {
  workspaceId: string;
  onDone: () => void;
  onMoreDetails: (draft: TaskDraft) => void;
}) {
  const title = useSignal('');
  const assignee = useSignal<'agent' | 'user'>('agent');
  const addToQueue = useSignal(true);
  const saving = useSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (!title.value.trim()) return;
    saving.value = true;
    try {
      const task = await createTask({
        title: title.value.trim(),
        assignedTo: assignee.value,
        workspaceId,
      });
      if (assignee.value === 'agent' && addToQueue.value && findMove(task, 'queue')) {
        await performMove(task, { to: 'queue' });
      }
      showToast('success', `Added: ${task.title}`);
      title.value = '';
      onDone();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not add the task.');
    } finally {
      saving.value = false;
    }
  }

  return (
    <form onSubmit={submit} class="flex flex-col gap-3" data-testid="quick-add-form">
      <Input
        aria-label="Task title"
        placeholder="What needs doing?"
        value={title.value}
        onInput={(e) => {
          title.value = (e.target as HTMLInputElement).value;
        }}
      />
      <div class="flex gap-2" role="radiogroup" aria-label="Assign to">
        {(['agent', 'user'] as const).map((who) => (
          <Button
            key={who}
            type="button"
            size="sm"
            role="radio"
            aria-checked={assignee.value === who}
            variant={assignee.value === who ? 'default' : 'outline'}
            onClick={() => (assignee.value = who)}
          >
            {who === 'agent' ? 'Agent' : 'Me'}
          </Button>
        ))}
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={addToQueue.value && assignee.value === 'agent'}
          disabled={assignee.value !== 'agent'}
          onChange={(e) => {
            addToQueue.value = (e.target as HTMLInputElement).checked;
          }}
        />
        Add to queue now
      </label>
      <div class="flex justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onMoreDetails({
              title: title.value,
              assignedTo: assignee.value,
              addToQueue: assignee.value === 'agent' && addToQueue.value,
            })
          }
        >
          More details
        </Button>
        <Button type="submit" size="sm" disabled={saving.value || !title.value.trim()}>
          {saving.value ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </form>
  );
}

// The Tasks tab below 1024px: sections ordered by urgency, each collapsible
// (remembered per browser), one-tap actions on the cards, and a quick-add
// sheet. There's no drag on touch — every status change is an explicit
// action, or "Move to…" in the task drawer.
export function TaskListMobile({
  workspaceId,
  taskList,
  onSaved,
  onGoToChat,
}: {
  workspaceId: string;
  taskList: Task[];
  onSaved: () => void;
  onGoToChat: () => void;
}) {
  const sections = mobileSections(taskList, queueState.value);
  const collapsed = useSignal<Partial<Record<MobileSection, boolean>>>(
    readJson(COLLAPSE_STORAGE_KEY, DEFAULT_COLLAPSED),
  );
  const toggle = (section: MobileSection) => {
    collapsed.value = { ...collapsed.value, [section]: !collapsed.value[section] };
    writeJson(COLLAPSE_STORAGE_KEY, collapsed.value);
  };

  const drawerOpen = useSignal(false);
  const selectedId = useSignal<string | null>(null);
  const selected = useComputed(() => taskList.find((t) => t.id === selectedId.value) ?? null);

  const replyOpen = useSignal(false);
  const replyId = useSignal<string | null>(null);
  const replyTask = useComputed(() => taskList.find((t) => t.id === replyId.value) ?? null);
  const openReply = (task: Task) => {
    replyId.value = task.id;
    replyOpen.value = true;
  };

  const quickAddOpen = useSignal(false);
  const newTaskOpen = useSignal(false);
  const newTaskDraft = useSignal<TaskDraft | undefined>(undefined);

  const openTask = (task: Task) => {
    if (task.board?.reason?.kind === 'waiting_on_user' && findMove(task, 'queue')) {
      openReply(task);
      return;
    }
    selectedId.value = task.id;
    drawerOpen.value = true;
  };

  const replyReason = replyTask.value?.board?.reason;

  return (
    <div class="flex flex-col gap-4 p-4 pb-24" data-testid="task-list-mobile">
      {SECTION_ORDER.filter((section) => sections[section].length > 0).map((section) => {
        const isCollapsed = collapsed.value[section] ?? false;
        return (
          <section key={section} data-section={section} aria-label={SECTION_LABELS[section]}>
            <button
              type="button"
              class="flex w-full items-center gap-2 py-1 text-left"
              aria-expanded={!isCollapsed}
              data-testid="section-toggle"
              onClick={() => toggle(section)}
            >
              {isCollapsed ? <ChevronRight class="size-4" /> : <ChevronDown class="size-4" />}
              <h3 class="text-sm font-semibold">{SECTION_LABELS[section]}</h3>
              <span class="text-xs text-muted-foreground">{sections[section].length}</span>
            </button>
            {!isCollapsed && (
              <div class="mt-2 flex flex-col gap-2">
                {sections[section].map((task) => (
                  <BoardCard
                    key={task.id}
                    task={task}
                    compact
                    role="button"
                    tabIndex={0}
                    onClick={() => openTask(task)}
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key === 'Enter') openTask(task);
                    }}
                    action={<PrimaryAction task={task} onReply={openReply} />}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {taskList.length === 0 && (
        <p class="py-8 text-center text-sm text-muted-foreground">No tasks yet.</p>
      )}

      <Button
        type="button"
        aria-label="Quick add task"
        data-testid="quick-add-button"
        class="fixed bottom-6 right-6 size-12 rounded-full shadow-lg"
        onClick={() => (quickAddOpen.value = true)}
      >
        <Plus class="size-5" />
      </Button>

      <BottomSheet title="Answer the agent" open={replyOpen}>
        {replyTask.value && replyReason?.kind === 'waiting_on_user' && (
          <ReplyForm
            key={replyTask.value.id}
            task={replyTask.value}
            reason={replyReason}
            onSent={() => (replyOpen.value = false)}
          />
        )}
      </BottomSheet>

      <BottomSheet title="New task" open={quickAddOpen}>
        <QuickAddForm
          workspaceId={workspaceId}
          onDone={() => (quickAddOpen.value = false)}
          onMoreDetails={(draft) => {
            quickAddOpen.value = false;
            newTaskDraft.value = draft;
            newTaskOpen.value = true;
          }}
        />
      </BottomSheet>

      <TaskDrawer
        task={selected.value}
        open={drawerOpen}
        defaultWorkspaceId={workspaceId}
        onSaved={onSaved}
        onGoToChat={onGoToChat}
      />
      <TaskDrawer
        task={null}
        draft={newTaskDraft.value}
        open={newTaskOpen}
        defaultWorkspaceId={workspaceId}
        onSaved={onSaved}
      />
    </div>
  );
}
