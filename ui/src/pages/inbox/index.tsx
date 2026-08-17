import { useEffect } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { useComputed } from '@preact/signals';
import { Plus, Inbox as InboxIcon } from 'lucide-preact';

import { Layout } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { TaskDrawer } from '@/components/task-drawer';
import { tasks, refreshTasks } from '@/hooks/use-tasks';
import type { Task } from '@/services/tasks-api';

// forwardRef required so Dialog.tsx can attach its click→showModal ref to the
// row element (preactjs/preact#3297 silently drops refs on plain functions).
const TaskRow = forwardRef<HTMLTableRowElement, { task: Task }>(function TaskRow({ task }, ref) {
  return (
    <tr
      ref={ref}
      data-testid="inbox-task-row"
      data-task-id={task.id}
      class="border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
    >
      <td class="px-4 py-3">
        <p class="font-medium text-sm">{task.title}</p>
        {task.outcome && (
          <p class="text-xs text-muted-foreground mt-0.5 truncate max-w-sm">{task.outcome}</p>
        )}
      </td>
      <td class="px-4 py-3">
        {task.assignedTo ? (
          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground capitalize">
            {task.assignedTo}
          </span>
        ) : (
          <span class="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td class="px-4 py-3">
        <span class="text-xs text-muted-foreground capitalize">{task.triggerType}</span>
      </td>
      <td class="px-4 py-3">
        <span class="text-xs text-muted-foreground capitalize">{task.status}</span>
      </td>
      <td class="px-4 py-3">
        {task.dueAt ? (
          <span class="text-xs text-muted-foreground">
            {new Date(task.dueAt).toLocaleDateString()}
          </span>
        ) : (
          <span class="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
});

const TABLE_HEADER = (
  <tr class="border-b border-border bg-muted/40">
    <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Task</th>
    <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Assigned</th>
    <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Trigger</th>
    <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Status</th>
    <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Due</th>
  </tr>
);

function InboxTable({ taskList, onSaved }: { taskList: Task[]; onSaved: () => void }) {
  return (
    <div class="border border-border rounded-xl overflow-hidden">
      <table class="w-full">
        <thead>{TABLE_HEADER}</thead>
        <tbody>
          {taskList.map((task) => (
            <TaskDrawer
              key={task.id}
              task={task}
              defaultWorkspaceId={null}
              onSaved={onSaved}
              trigger={<TaskRow task={task} />}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// path prop is consumed by preact-iso's Router for route matching
export function InboxView(_props: { path?: string }) {
  useEffect(() => {
    void refreshTasks({ workspace_id: null });
  }, []);

  const inboxTasks = useComputed(() => tasks.value.filter((t) => !t.workspaceId));

  const dueSoon = useComputed(() =>
    inboxTasks.value
      .filter((t) => t.dueAt)
      .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime()),
  );

  const noDueDate = useComputed(() => inboxTasks.value.filter((t) => !t.dueAt));

  function onSaved() {
    void refreshTasks({ workspace_id: null });
  }

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="px-6 pt-6 pb-4">
          <div class="flex items-start justify-between gap-4 mb-6">
            <div class="flex items-center gap-2">
              <InboxIcon class="size-5 text-muted-foreground" />
              <div>
                <h1 class="text-xl font-semibold">Inbox</h1>
                <p class="text-sm text-muted-foreground mt-0.5">
                  Tasks not assigned to any workspace
                </p>
              </div>
            </div>
            <TaskDrawer
              task={null}
              defaultWorkspaceId={null}
              onSaved={onSaved}
              trigger={
                <Button>
                  <Plus class="size-4" />
                  New task
                </Button>
              }
            />
          </div>

          {inboxTasks.value.length === 0 && (
            <div
              data-testid="inbox-empty"
              class="flex flex-col items-center justify-center py-16 text-center"
            >
              <InboxIcon class="size-10 text-muted-foreground/40 mb-3" />
              <p class="text-sm text-muted-foreground">Inbox is empty</p>
              <p class="text-xs text-muted-foreground/70 mt-1">
                Tasks without a workspace will appear here
              </p>
            </div>
          )}

          {dueSoon.value.length > 0 && (
            <div data-testid="inbox-due-soon" class="mb-6">
              <h2 class="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider text-xs">
                Due soon
              </h2>
              <InboxTable taskList={dueSoon.value} onSaved={onSaved} />
            </div>
          )}

          {noDueDate.value.length > 0 && (
            <div data-testid="inbox-no-due-date">
              <h2 class="text-xs font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
                No due date
              </h2>
              <InboxTable taskList={noDueDate.value} onSaved={onSaved} />
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
