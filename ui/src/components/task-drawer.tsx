import { useSignal, useComputed } from '@preact/signals';
import { Sparkles, GripVertical, Plus, X, Loader2, ExternalLink, Copy, Check } from 'lucide-preact';
import type { JSX } from 'preact';
import { useRef, useEffect } from 'preact/hooks';

import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  createTask,
  patchTask,
  updatePlan,
  generatePlan,
  generatePlanForNewTask,
} from '@/hooks/use-tasks';
import { workspaces } from '@/hooks/use-workspaces';
import type {
  Task,
  TaskStatus,
  TriggerType,
  PlanStep,
  CreateTaskInput,
} from '@/services/tasks-api';
import {
  listTrackers,
  resolveTrackerUrl,
  getTrackerItem,
  createTrackerItem,
  type Tracker,
  type TrackerItem,
} from '@/services/trackers-api';

const TRACKER_STATE_LABELS: Record<TrackerItem['state'], string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

// Best-effort "owner/repo" extraction from a workspace's free-text remote URL
// (e.g. "https://github.com/org/repo" or "git@github.com:org/repo.git"), used
// only to prefill the create-issue mini-form's repo field.
function parseGithubRepo(remoteUrl: string | null | undefined): string {
  if (!remoteUrl) return '';
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : '';
}

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
  const triggerType = useSignal<TriggerType>(task?.triggerType ?? 'manual');
  const webhookToken = useSignal<string | null>(
    (task?.triggerConfig as { webhookToken?: string } | null)?.webhookToken ?? null,
  );
  const copied = useSignal(false);
  const regenerating = useSignal(false);
  const regenerateError = useSignal('');
  const dueAt = useSignal(task?.dueAt ? task.dueAt.slice(0, 10) : '');
  const workspaceId = useSignal<string | null>(task?.workspaceId ?? defaultWorkspaceId ?? null);
  const planSteps = useSignal<PlanStep[]>(task?.plan ?? []);
  const generatingPlan = useSignal(false);
  const generatePlanError = useSignal('');
  const saving = useSignal(false);
  const error = useSignal('');

  const trackerType = useSignal<string | null>(task?.trackerType ?? null);
  const trackerId = useSignal<string | null>(task?.trackerId ?? null);
  const trackers = useSignal<Tracker[]>([]);
  const trackerUrlInput = useSignal('');
  const trackerPreview = useSignal<TrackerItem | null>(null);
  const trackerResolving = useSignal(false);
  const trackerResolveError = useSignal('');
  const trackerUrlTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showCreateForm = useSignal(false);
  const createTitle = useSignal(task?.title ?? '');
  const createBody = useSignal(task?.description ?? '');
  const createRepo = useSignal('');
  const createSaving = useSignal(false);
  const createError = useSignal('');

  const selectedTracker = useComputed(() =>
    trackers.value.find((t) => t.type === trackerType.value),
  );

  useEffect(() => {
    void listTrackers()
      .then((result) => {
        trackers.value = result;
      })
      .catch(() => {
        // best-effort — the type select just stays empty if this fails
      });
  }, []);

  useEffect(() => {
    if (task?.trackerType && task?.trackerId) {
      void getTrackerItem(task.trackerType, task.trackerId)
        .then((item) => {
          trackerPreview.value = item;
        })
        .catch(() => {
          // best-effort — keep showing the stored link even if the live fetch fails
        });
    }
  }, []);

  useEffect(() => {
    const ws = workspaces.value.find((w) => w.id === workspaceId.value);
    createRepo.value = parseGithubRepo(ws?.remoteUrl);
  }, [workspaceId.value]);

  function handleTrackerTypeChange(value: string) {
    trackerType.value = value || null;
    trackerId.value = null;
    trackerPreview.value = null;
    trackerUrlInput.value = '';
    trackerResolveError.value = '';
    showCreateForm.value = false;
  }

  function handleTrackerUrlInput(value: string) {
    trackerUrlInput.value = value;
    trackerPreview.value = null;
    trackerId.value = null;
    trackerResolveError.value = '';
    if (trackerUrlTimeout.current) clearTimeout(trackerUrlTimeout.current);
    const type = trackerType.value;
    const url = value.trim();
    if (!type || !url) return;
    trackerUrlTimeout.current = setTimeout(() => void resolveTypedUrl(type, url), 400);
  }

  async function resolveTypedUrl(type: string, url: string) {
    trackerResolving.value = true;
    try {
      const item = await resolveTrackerUrl(type, url);
      trackerPreview.value = item;
      trackerId.value = item.id;
      trackerResolveError.value = '';
    } catch (err) {
      trackerResolveError.value =
        err instanceof Error ? err.message : 'Could not resolve this URL.';
    } finally {
      trackerResolving.value = false;
    }
  }

  async function handleCopyWebhookUrl() {
    const url = `${window.location.origin}/api/v1/triggers/webhook/${webhookToken.value ?? ''}`;
    await navigator.clipboard.writeText(url);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  }

  async function handleRegenerateWebhookToken() {
    if (!task) return;
    if (!confirm('This will invalidate the current URL. Continue?')) return;
    regenerating.value = true;
    regenerateError.value = '';
    try {
      const updated = await patchTask(task.id, { regenerateWebhookToken: true });
      webhookToken.value =
        (updated.triggerConfig as { webhookToken?: string } | null)?.webhookToken ?? null;
    } catch (err) {
      regenerateError.value = err instanceof Error ? err.message : 'Failed to regenerate URL.';
    } finally {
      regenerating.value = false;
    }
  }

  function unlinkTracker() {
    trackerId.value = null;
    trackerPreview.value = null;
    trackerUrlInput.value = '';
    trackerResolveError.value = '';
  }

  async function handleCreateTrackerItem() {
    if (!trackerType.value || !createTitle.value.trim()) return;
    createSaving.value = true;
    createError.value = '';
    try {
      const item = await createTrackerItem(trackerType.value, {
        title: createTitle.value.trim(),
        body: createBody.value.trim() || undefined,
        repo: createRepo.value.trim() || undefined,
      });
      trackerId.value = item.id;
      trackerPreview.value = item;
      showCreateForm.value = false;
    } catch (err) {
      createError.value = err instanceof Error ? err.message : 'Failed to create issue.';
    } finally {
      createSaving.value = false;
    }
  }

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

  async function handleGeneratePlan() {
    if (!title.value.trim() || generatingPlan.value) return;
    generatingPlan.value = true;
    generatePlanError.value = '';
    try {
      const generated = task
        ? await generatePlan(task.id)
        : await generatePlanForNewTask({
            title: title.value.trim(),
            description: description.value.trim() || null,
            workspaceId: workspaceId.value,
          });
      const next = [...planSteps.value, ...generated];
      planSteps.value = next;
      if (task) {
        void updatePlan(task.id, next);
      }
    } catch (err) {
      generatePlanError.value = err instanceof Error ? err.message : 'Could not generate a plan.';
    } finally {
      generatingPlan.value = false;
    }
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
        triggerType: triggerType.value,
        dueAt: dueAt.value || null,
        workspaceId: workspaceId.value,
        plan: planSteps.value.filter((s) => s.step.trim()),
        trackerType: trackerType.value,
        trackerId: trackerId.value,
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
              class="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                !title.value.trim()
                  ? 'Add a title before generating a plan'
                  : 'Generate plan with AI'
              }
              aria-label="Generate plan with AI"
              disabled={!title.value.trim() || generatingPlan.value}
              onClick={handleGeneratePlan}
            >
              {generatingPlan.value ? (
                <Loader2 class="size-3.5 animate-spin" />
              ) : (
                <Sparkles class="size-3.5" />
              )}
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
          {generatePlanError.value && (
            <p class="text-xs text-destructive">{generatePlanError.value}</p>
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

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Trigger</label>
          <select
            data-testid="task-trigger-type-select"
            value={triggerType.value}
            onChange={(e) => {
              triggerType.value = (e.target as HTMLSelectElement).value as TriggerType;
            }}
            class="border border-input rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
          >
            <option value="manual">Manual</option>
            <option value="webhook">Webhook</option>
          </select>

          {triggerType.value === 'webhook' &&
            (isNew ? (
              <p class="text-xs text-muted-foreground mt-1">
                Webhook URL is generated once the task is saved.
              </p>
            ) : (
              <div class="flex flex-col gap-2 mt-1">
                <div class="flex items-center gap-2">
                  <Input
                    readOnly
                    data-testid="task-webhook-url"
                    value={`${window.location.origin}/api/v1/triggers/webhook/${webhookToken.value ?? ''}`}
                    class="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    data-testid="task-webhook-copy-button"
                    onClick={() => void handleCopyWebhookUrl()}
                  >
                    {copied.value ? <Check class="size-3.5" /> : <Copy class="size-3.5" />}
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={regenerating.value}
                  onClick={() => void handleRegenerateWebhookToken()}
                >
                  {regenerating.value ? 'Regenerating…' : 'Regenerate URL'}
                </Button>
                {regenerateError.value && (
                  <p class="text-xs text-destructive">{regenerateError.value}</p>
                )}
              </div>
            ))}
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Tracker</label>
          <select
            data-testid="task-tracker-type-select"
            value={trackerType.value ?? ''}
            onChange={(e) => handleTrackerTypeChange((e.target as HTMLSelectElement).value)}
            class="border border-input rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
          >
            <option value="">Not linked</option>
            {trackers.value.map((t) => (
              <option key={t.type} value={t.type}>
                {t.displayName}
              </option>
            ))}
          </select>

          {trackerType.value && (
            <div class="flex flex-col gap-2 mt-1">
              {trackerPreview.value ? (
                <div
                  data-testid="task-tracker-preview"
                  class="border border-border rounded-lg px-3 py-2 flex items-center justify-between gap-2"
                >
                  <div class="min-w-0 flex flex-col gap-0.5">
                    <a
                      href={trackerPreview.value.url}
                      target="_blank"
                      rel="noreferrer"
                      class="text-sm font-medium truncate hover:underline flex items-center gap-1"
                    >
                      {trackerPreview.value.title}
                      <ExternalLink class="size-3 shrink-0 text-muted-foreground" />
                    </a>
                    <span class="text-xs text-muted-foreground">
                      {TRACKER_STATE_LABELS[trackerPreview.value.state]}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={unlinkTracker}
                    class="shrink-0 text-xs text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Unlink
                  </button>
                </div>
              ) : (
                <>
                  <Input
                    placeholder="Paste a tracker URL to link it"
                    value={trackerUrlInput.value}
                    onInput={(e) => handleTrackerUrlInput((e.target as HTMLInputElement).value)}
                  />
                  {trackerResolving.value && (
                    <p class="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Loader2 class="size-3 animate-spin" />
                      Resolving…
                    </p>
                  )}
                  {trackerResolveError.value && (
                    <p class="text-xs text-destructive">{trackerResolveError.value}</p>
                  )}
                </>
              )}

              {selectedTracker.value?.canCreate && !trackerPreview.value && (
                <div class="border border-border rounded-lg p-2">
                  {!showCreateForm.value ? (
                    <button
                      type="button"
                      onClick={() => (showCreateForm.value = true)}
                      class="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Plus class="size-3" />
                      Create new issue
                    </button>
                  ) : (
                    <div class="flex flex-col gap-2">
                      <Input
                        placeholder="owner/repo"
                        value={createRepo.value}
                        onInput={(e) => {
                          createRepo.value = (e.target as HTMLInputElement).value;
                        }}
                      />
                      <Input
                        placeholder="Issue title"
                        value={createTitle.value}
                        onInput={(e) => {
                          createTitle.value = (e.target as HTMLInputElement).value;
                        }}
                      />
                      <textarea
                        placeholder="Issue body (optional)"
                        value={createBody.value}
                        onInput={(e) => {
                          createBody.value = (e.target as HTMLTextAreaElement).value;
                        }}
                        class="border border-input rounded-lg px-3 py-2 text-sm resize-none h-16 bg-background focus:outline-none focus:ring-2 focus:ring-ring/50"
                      />
                      {createError.value && (
                        <p class="text-xs text-destructive">{createError.value}</p>
                      )}
                      <div class="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => (showCreateForm.value = false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          disabled={createSaving.value || !createTitle.value.trim()}
                          onClick={() => void handleCreateTrackerItem()}
                        >
                          {createSaving.value ? 'Creating…' : 'Create issue'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
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
