import { useEffect } from 'preact/hooks';
import { useComputed, useSignal } from '@preact/signals';
import { Button } from '@/components/ui/button';
import { CardBadge } from '@/components/card-badge';
import { TaskDrawer } from '@/components/task-drawer';
import { queueState, refreshQueue, cancelTask, pauseTask } from '@/hooks/use-tasks';
import { workspaces, refreshWorkspaces } from '@/hooks/use-workspaces';
import { fetchProviders } from '@/hooks/use-providers';
import { showToast } from '@/lib/toast';
import type { Task } from '@/services/tasks-api';
import { buildTaskQueueRows, formatElapsed, type TaskQueueRow } from './task-queue-rows';
import { ProviderPickButton } from './provider-pick';

function TaskQueueTableRow({ row, onOpen }: { row: TaskQueueRow; onOpen: (task: Task) => void }) {
  async function handlePause(e: MouseEvent) {
    e.stopPropagation();
    try {
      await pauseTask(row.task.id);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not pause the task.');
    }
  }

  async function handleCancel(e: MouseEvent) {
    e.stopPropagation();
    if (!confirm('Cancel this task? In-progress work will be discarded.')) return;
    try {
      await cancelTask(row.task.id);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not cancel the task.');
    }
  }

  return (
    <tr
      data-testid="monitoring-queue-row"
      data-task-id={row.task.id}
      class="border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
      onClick={() => onOpen(row.task)}
    >
      <td class="px-4 py-3">
        <p class="font-medium text-sm">{row.task.title}</p>
      </td>
      <td class="px-4 py-3">
        <span class="text-xs text-muted-foreground">{row.workspaceName}</span>
      </td>
      <td class="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <ProviderPickButton task={row.task} />
      </td>
      <td class="px-4 py-3">
        <CardBadge variant={row.status === 'running' ? 'green' : 'blue'}>
          {row.status === 'running' ? 'Running' : 'Queued'}
        </CardBadge>
      </td>
      <td class="px-4 py-3">
        <span class="text-xs text-muted-foreground font-mono">{formatElapsed(row.elapsedMs)}</span>
      </td>
      <td class="px-4 py-3">
        <div class="flex items-center justify-end gap-2">
          {row.status === 'running' && (
            <Button type="button" size="xs" variant="outline" onClick={handlePause}>
              Pause
            </Button>
          )}
          <Button type="button" size="xs" variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
        </div>
      </td>
    </tr>
  );
}

// The Task Queue Monitor (GLOSSARY.md § Monitoring) — every Task currently
// in the Queue lane, app-wide, composed client-side from the same live
// `queueState` the sidebar Queue Widget already aggregates (no new backend
// endpoint — see docs/superpowers/specs/2026-11-16-monitoring-task-queue-provider-activity-design.md).
export function TaskQueueMonitor() {
  useEffect(() => {
    void refreshQueue();
    void refreshWorkspaces();
    void fetchProviders();
  }, []);

  // Keeps the Elapsed column ticking without needing a fresh queueState
  // from the server — re-renders the row set on an interval, not the
  // network fetch.
  const tick = useSignal(0);
  useEffect(() => {
    const id = setInterval(() => tick.value++, 1000);
    return () => clearInterval(id);
  }, []);

  const rows = useComputed(() => {
    tick.value; // subscribe — see effect above
    return buildTaskQueueRows(queueState.value, workspaces.value);
  });

  const openTask = useSignal<Task | null>(null);
  const drawerOpen = useSignal(false);

  function onOpen(task: Task) {
    openTask.value = task;
    drawerOpen.value = true;
  }

  return (
    <section class="mb-9">
      <div class="mb-3">
        <h2 class="text-base font-semibold">Task Queue — all workspaces</h2>
        <p class="text-xs text-muted-foreground mt-0.5">
          Every task currently pending or running, app-wide — including which provider/model it's
          pinned to, so you can switch it off an overloaded one instead of just cancelling.
        </p>
      </div>

      {rows.value.length === 0 ? (
        <div class="border border-border rounded-xl py-10 text-center text-sm text-muted-foreground">
          Nothing in the queue right now.
        </div>
      ) : (
        <div class="border border-border rounded-xl overflow-hidden overflow-x-auto">
          <table class="w-full min-w-[720px]">
            <thead>
              <tr class="border-b border-border bg-muted/40">
                <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Task</th>
                <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Workspace
                </th>
                <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Provider
                </th>
                <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Status
                </th>
                <th class="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Elapsed
                </th>
                <th class="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.value.map((row) => (
                <TaskQueueTableRow key={row.queueEntryId} row={row} onOpen={onOpen} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TaskDrawer
        task={openTask.value}
        defaultWorkspaceId={openTask.value?.workspaceId ?? null}
        open={drawerOpen}
        onSaved={() => void refreshQueue()}
      />
    </section>
  );
}
