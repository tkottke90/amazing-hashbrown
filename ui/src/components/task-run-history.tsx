import { useSignal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { fetchTaskRuns, type TaskRun } from '@/services/tasks-api';
import { runName, runPath, triggerSourceLabel } from '@/lib/task-runs';

// A task's runs, newest first — refetched whenever refreshKey changes (the
// drawer passes the task's live status, so a run starting, pausing or
// finishing shows up without reopening the drawer). Best-effort: a failed
// fetch just leaves the list empty.
export function useTaskRuns(taskId: string | null, refreshKey: unknown): Signal<TaskRun[]> {
  const runs = useSignal<TaskRun[]>([]);
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    void fetchTaskRuns(taskId)
      .then((result) => {
        if (!cancelled) runs.value = result;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);
  return runs;
}

// The run that is waiting on the user, if any — its question lives in that
// run's thread, which is where the drawer's "waiting" banner sends them.
export function waitingRun(runs: TaskRun[]): TaskRun | null {
  return runs.find((r) => r.status === 'paused' && r.threadId !== null) ?? null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// The drawer's run history: one row per run, opening that run's read-only
// transcript. Runs recorded before each run had its own thread have no
// transcript to open, so their row is plain text.
export function TaskRunHistory({ runs, onOpen }: { runs: TaskRun[]; onOpen?: () => void }) {
  const { route } = useLocation();
  if (runs.length === 0) return null;

  return (
    <div class="flex flex-col gap-1" data-testid="task-run-history">
      <label class="text-xs font-medium text-muted-foreground">Run history</label>
      <ul class="flex flex-col gap-1">
        {runs.map((run) => {
          const body = (
            <>
              <span class="text-xs">
                <span class="font-medium">{runName(run.runNumber, run.triggerSource)}</span>
                {' · '}
                {triggerSourceLabel(run.triggerSource)} · {run.status}
                {run.startedAt ? ` · ${relativeTime(run.startedAt)}` : ''}
              </span>
              {run.summary && (
                <span class="text-xs text-muted-foreground line-clamp-2">{run.summary}</span>
              )}
            </>
          );
          return (
            <li key={run.id}>
              {run.threadId ? (
                <button
                  type="button"
                  data-testid="task-run-history-row"
                  class="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1 text-left bg-muted/50 hover:bg-muted"
                  onClick={() => {
                    onOpen?.();
                    route(runPath(run.threadId!));
                  }}
                >
                  {body}
                </button>
              ) : (
                <div
                  data-testid="task-run-history-row"
                  class="flex flex-col gap-0.5 rounded px-2 py-1 bg-muted/30"
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
