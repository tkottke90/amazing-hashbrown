import { useSignal, useComputed } from '@preact/signals';
import { Sparkles, GripVertical, Plus, X } from 'lucide-preact';
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';

import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { createTask, patchTask, updatePlan } from '@/hooks/use-tasks';
import { workspaces } from '@/hooks/use-workspaces';
import type { Task, TaskStatus, PlanStep, CreateTaskInput } from '@/services/tasks-api';

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  waiting_on_user: 'Waiting on user',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface TaskDrawerProps {
  task?: Task | null;
  trigger: JSX.Element;
  defaultWorkspaceId?: string | null;
  onSaved?: (task: Task) => void;
}

export function TaskDrawer({ task, trigger, defaultWorkspaceId, onSaved }: TaskDrawerProps) {
  const isNew = !task;
  return (
    <Drawer
      trigger={trigger}
      title={isNew ? 'New task' : 'Task details'}
      className="!p-0 !bg-background !rounded-none !border-0 border-l border-border"
    >
      <TaskForm task={task} defaultWorkspaceId={defaultWorkspaceId} onSaved={onSaved} />
    </Drawer>
  );
}

interface TaskFormProps {
  task?: Task | null;
  defaultWorkspaceId?: string | null;
  onSaved?: (task: Task) => void;
}

function TaskForm({ task, defaultWorkspaceId, onSaved }: TaskFormProps) {
  const { close } = useDialog();

  const isNew = !task;
  const title = useSignal(task?.title ?? '');
  const description = useSignal(task?.description ?? '');
  const outcome = useSignal(task?.outcome ?? '');
  const status = useSignal<TaskStatus>(task?.status ?? 'pending');
  const assignedTo = useSignal<'user' | 'agent' | null>(task?.assignedTo ?? null);
  const dueAt = useSignal(task?.dueAt ? task.dueAt.slice(0, 10) : '');
  const workspaceId = useSignal<string | null>(task?.workspaceId ?? defaultWorkspaceId ?? null);
  const planSteps = useSignal<PlanStep[]>(task?.plan ?? []);
  const saving = useSignal(false);
  const error = useSignal('');

  const completedCount = useComputed(() => planSteps.value.filter((s) => s.done).length);
  const totalCount = useComputed(() => planSteps.value.length);
  const planContainerRef = useRef<HTMLDivElement>(null);

  function addStep() {
    planSteps.value = [...planSteps.value, { step: '', done: false }];
    setTimeout(() => {
      const inputs =
        planContainerRef.current?.querySelectorAll<HTMLInputElement>('input[type="text"]');
      if (inputs?.length) inputs[inputs.length - 1]?.focus();
    }, 0);
  }

  function updateStep(idx: number, text: string) {
    const next = [...planSteps.value];
    const current = next[idx];
    if (!current) return;
    next[idx] = { ...current, step: text };
    planSteps.value = next;
  }

  function toggleStep(idx: number) {
    const next = [...planSteps.value];
    const current = next[idx];
    if (!current) return;
    next[idx] = { ...current, done: !current.done };
    planSteps.value = next;
    if (task) {
      void updatePlan(task.id, next);
    }
  }

  function removeStep(idx: number) {
    planSteps.value = planSteps.value.filter((_, i) => i !== idx);
  }

  async function handleSave(e: Event) {
    e.preventDefault();
    if (!title.value.trim()) {
      error.value = 'Title is required.';
      return;
    }
    saving.value = true;
    error.value = '';

    try {
      const patch: Partial<CreateTaskInput & { status: TaskStatus }> = {
        title: title.value.trim(),
        description: description.value.trim() || null,
        outcome: outcome.value.trim() || null,
        assignedTo: assignedTo.value,
        dueAt: dueAt.value || null,
        workspaceId: workspaceId.value,
        plan: planSteps.value.filter((s) => s.step.trim()),
      };

      let saved: Task;
      if (isNew) {
        saved = await createTask({ ...patch, title: patch.title! });
      } else {
        saved = await patchTask(task.id, { ...patch, status: status.value });
      }
      onSaved?.(saved);
      close();
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to save.';
    } finally {
      saving.value = false;
    }
  }

  const planProgress = totalCount.value > 0 ? (completedCount.value / totalCount.value) * 100 : 0;

  return (
    <form onSubmit={handleSave} class="flex flex-col flex-1 min-h-0 mt-2">
      <div class="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Title</label>
          <Input
            autoFocus
            placeholder="Task title"
            value={title.value}
            onInput={(e) => {
              title.value = (e.target as HTMLInputElement).value;
            }}
            required
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Description</label>
          <textarea
            placeholder="What needs to be done?"
            value={description.value}
            onInput={(e) => {
              description.value = (e.target as HTMLTextAreaElement).value;
            }}
            class="border border-input rounded-lg px-3 py-2 text-sm resize-none h-20 bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Outcome</label>
          <textarea
            placeholder="A clear definition of done"
            value={outcome.value}
            onInput={(e) => {
              outcome.value = (e.target as HTMLTextAreaElement).value;
            }}
            class="border border-input rounded-lg px-3 py-2 text-sm resize-none h-20 bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </div>

        <div class="flex flex-col gap-1" data-testid="task-plan">
          <div class="flex items-center justify-between">
            <label class="text-xs font-medium text-muted-foreground">Plan</label>
            <button
              type="button"
              class="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Generate plan with AI"
              aria-label="Generate plan with AI"
            >
              <Sparkles class="size-3.5" />
            </button>
          </div>
          <div class="border border-border rounded-lg overflow-hidden">
            {totalCount.value > 0 && (
              <div class="px-3 py-2 border-b border-border bg-muted/30">
                <div class="flex items-center justify-between text-xs text-muted-foreground mb-1">
                  <span>
                    {completedCount.value} of {totalCount.value} steps
                  </span>
                </div>
                <div class="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    class="h-full bg-primary rounded-full transition-all"
                    style={{ width: `${planProgress}%` }}
                  />
                </div>
              </div>
            )}

            <div ref={planContainerRef} class="divide-y divide-border">
              {planSteps.value.map((step, idx) => (
                <div
                  key={idx}
                  data-testid="plan-step"
                  data-done={step.done ? 'true' : 'false'}
                  class="flex items-center gap-2 px-3 py-2"
                >
                  <GripVertical class="size-3.5 text-muted-foreground/50 shrink-0 cursor-grab" />
                  <input
                    data-testid="plan-step-checkbox"
                    type="checkbox"
                    checked={step.done}
                    onChange={() => toggleStep(idx)}
                    class="shrink-0 cursor-pointer"
                    aria-label={`Mark step "${step.step}" as done`}
                  />
                  <input
                    type="text"
                    value={step.step}
                    onInput={(e) => updateStep(idx, (e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addStep();
                      }
                    }}
                    placeholder="Step description"
                    class={cn(
                      'flex-1 text-sm bg-transparent outline-none',
                      step.done && 'line-through text-muted-foreground',
                    )}
                    aria-label={`Plan step ${idx + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeStep(idx)}
                    class="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:text-destructive transition-colors"
                    aria-label="Remove step"
                  >
                    <X class="size-3" />
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addStep}
              class="flex items-center gap-1.5 w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            >
              <Plus class="size-3" />
              Add a step
            </button>

            {totalCount.value === 0 && (
              <p class="px-3 pb-2 text-xs text-muted-foreground">
                No plan yet.{' '}
                <button type="button" onClick={addStep} class="underline">
                  Add steps
                </button>
              </p>
            )}
          </div>
          {totalCount.value > 0 && (
            <p class="text-[10px] text-muted-foreground mt-0.5">Drag rows to reorder steps</p>
          )}
        </div>

        {!isNew && status.value === 'running' && (
          <div class="rounded-lg bg-muted/50 border border-border p-3 flex items-center gap-2 flex-wrap">
            <span class="text-xs text-muted-foreground flex-1">Running task controls</span>
            <Button size="xs" variant="outline" type="button">
              Pause
            </Button>
            <Button size="xs" variant="outline" type="button">
              Take over
            </Button>
            <Button size="xs" variant="destructive" type="button">
              Cancel
            </Button>
          </div>
        )}

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Assigned to</label>
          <select
            value={assignedTo.value ?? ''}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              assignedTo.value = v === 'user' ? 'user' : v === 'agent' ? 'agent' : null;
            }}
            class="border border-input rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
          >
            <option value="">Unassigned</option>
            <option value="user">User</option>
            <option value="agent">Agent</option>
          </select>
        </div>

        <div class="grid grid-cols-2 gap-3">
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
          {!isNew && (
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium text-muted-foreground">Status</label>
              <select
                data-testid="task-status-select"
                value={status.value}
                onChange={(e) => {
                  status.value = (e.target as HTMLSelectElement).value as TaskStatus;
                }}
                class="border border-input rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
              >
                {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Workspace</label>
          <select
            value={workspaceId.value ?? ''}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              workspaceId.value = v || null;
            }}
            class="border border-input rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
          >
            <option value="">None — inbox</option>
            {workspaces.value.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
        </div>

        {error.value && <p class="text-sm text-destructive">{error.value}</p>}
      </div>

      <div class="flex items-center gap-2 px-5 py-4 border-t border-border shrink-0 justify-end">
        <Button type="button" variant="ghost" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving.value}>
          {saving.value ? 'Saving…' : isNew ? 'Create task' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
