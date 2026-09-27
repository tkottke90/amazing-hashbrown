import { request } from '@/utils/fetch.utils';

export type TaskStatus =
  | 'pending'
  | 'scheduled'
  | 'ready'
  | 'running'
  | 'waiting_on_user'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TriggerType = 'manual' | 'chat' | 'cron_once' | 'cron_repeat' | 'webhook';

// What started one run of a task.
export type TriggerSource = 'manual' | 'webhook' | 'schedule' | 'catch_up' | 'chat' | 'agent';

export interface PlanStep {
  step: string;
  done: boolean;
}

// Server-computed state of a cron task's schedule (see the API's
// describeTaskSchedule): the UI never parses cron expressions itself.
export type ScheduleInactiveReason = 'disabled' | 'failures' | 'exhausted' | 'expired' | 'fired';

export interface TaskSchedule {
  nextFireAt: string | null;
  iterationCount: number;
  active: boolean;
  inactiveReason: ScheduleInactiveReason | null;
  lastRunOutcome: 'done' | 'failed' | 'cancelled' | null;
}

// trigger_config for the cron trigger types, as stored. The fields after
// the schedule itself are server-owned bookkeeping.
export interface CronOnceConfig {
  fireAt: string;
  timezone: string;
  enabled: boolean;
  enabledAt?: string;
  lastFiredAt?: string | null;
}

export interface CronRepeatConfig {
  expression: string;
  timezone: string;
  enabled: boolean;
  maxIterations: number | null;
  stopAfter: string | null;
  maxConsecutiveFailures: number | null;
  enabledAt?: string;
  lastFiredAt?: string | null;
  consecutiveFailures?: number;
  pausedReason?: 'consecutive_failures' | null;
}

export interface CronPreview {
  valid: boolean;
  error?: string;
  description: string;
  nextFireTimes: string[];
}

export type CronPreviewRequest =
  { expression: string; timezone: string } | { fireAt: string; timezone: string };

export interface Task {
  id: string;
  workspaceId: string | null;
  title: string;
  description: string | null;
  outcome: string | null;
  status: TaskStatus;
  assignedTo: 'user' | 'agent' | null;
  dueAt: string | null;
  expiresAt: string | null;
  triggerType: TriggerType;
  triggerConfig: unknown | null;
  trackerType: string | null;
  trackerId: string | null;
  plan: PlanStep[] | null;
  // Set when status is 'blocked' because a required dependency failed —
  // distinct from a plain user-initiated pause, which leaves this null.
  blockedReason: 'dependency_failed' | null;
  createdAt: string;
  updatedAt: string;
  // Present on cron tasks only.
  schedule?: TaskSchedule;
}

export interface TaskDependency {
  id: number;
  taskId: string;
  dependsOnTaskId: string;
  requireSuccess: boolean;
  whileBlocked: boolean;
  createdAt: string;
}

export interface TaskQueueEntry {
  id: string;
  taskId: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  position: number;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  recoveryAttempts: number;
  // Each queue row is one run with its own thread (null until it first
  // starts, or for a run recorded before per-run threads existed).
  threadId: string | null;
  summary: string | null;
  triggerSource: TriggerSource;
  scheduledFor: string | null;
}

// One run of a task, as the drawer's run history lists it.
export interface TaskRun extends TaskQueueEntry {
  runNumber: number;
}

export interface QueueState {
  queue: (TaskQueueEntry & { task: Task | null })[];
  running: (TaskQueueEntry & { task: Task })[];
}

export interface CreateTaskInput {
  title: string;
  workspaceId?: string | null;
  description?: string | null;
  outcome?: string | null;
  assignedTo?: 'user' | 'agent' | null;
  dueAt?: string | null;
  expiresAt?: string | null;
  triggerType?: TriggerType;
  triggerConfig?: unknown | null;
  trackerType?: string | null;
  trackerId?: string | null;
  plan?: PlanStep[] | null;
}

export interface TaskFilters {
  workspace_id?: string | null;
  status?: TaskStatus;
}

export async function fetchTasks(filters: TaskFilters = {}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filters.workspace_id !== undefined) {
    params.set('workspace_id', filters.workspace_id === null ? 'null' : filters.workspace_id);
  }
  if (filters.status !== undefined) {
    params.set('status', filters.status);
  }
  const qs = params.toString();
  return request<Task[]>(`/api/v1/tasks${qs ? `?${qs}` : ''}`);
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  return request<Task>('/api/v1/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function patchTask(
  id: string,
  patch: Partial<CreateTaskInput & { status: TaskStatus; regenerateWebhookToken: boolean }>,
): Promise<Task> {
  return request<Task>(`/api/v1/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteTask(id: string): Promise<void> {
  // A 204 has no body for request() to parse, so check the status here —
  // a refused delete (409 while a run is active) must surface, not vanish.
  const res = await fetch(`/api/v1/tasks/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
}

export async function previewCron(
  input: CronPreviewRequest,
  signal?: AbortSignal,
): Promise<CronPreview> {
  return request<CronPreview>('/api/v1/triggers/cron/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
}

export async function fetchQueue(): Promise<QueueState> {
  return request<QueueState>('/api/v1/tasks/queue');
}

export async function fetchTaskRuns(id: string, limit = 20): Promise<TaskRun[]> {
  return request<TaskRun[]>(`/api/v1/tasks/${id}/runs?limit=${limit}`);
}

export async function enqueueTask(id: string): Promise<TaskQueueEntry> {
  return request<TaskQueueEntry>(`/api/v1/tasks/${id}/enqueue`, { method: 'POST' });
}

export async function cancelTask(id: string): Promise<Task> {
  return request<Task>(`/api/v1/tasks/${id}/cancel`, { method: 'POST' });
}

export async function pauseTask(id: string): Promise<Task> {
  return request<Task>(`/api/v1/tasks/${id}/pause`, { method: 'POST' });
}

export async function takeOverTask(id: string): Promise<Task> {
  return request<Task>(`/api/v1/tasks/${id}/take-over`, { method: 'POST' });
}

export async function resumeTask(id: string): Promise<Task> {
  return patchTask(id, { status: 'ready' });
}

export async function generatePlan(taskId: string): Promise<PlanStep[]> {
  return request<PlanStep[]>(`/api/v1/tasks/${taskId}/generate-plan`, { method: 'POST' });
}

export async function listTaskDependencies(taskId: string): Promise<TaskDependency[]> {
  return request<TaskDependency[]>(`/api/v1/tasks/${taskId}/dependencies`);
}

export async function addTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
  opts: { requireSuccess?: boolean; whileBlocked?: boolean } = {},
): Promise<TaskDependency> {
  return request<TaskDependency>(`/api/v1/tasks/${taskId}/dependencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dependsOnTaskId, ...opts }),
  });
}

export async function removeTaskDependency(taskId: string, dependencyId: number): Promise<void> {
  // A 204 No Content response has no JSON body to parse — same reason
  // deleteTask() above bypasses request() and calls fetch() directly.
  await fetch(`/api/v1/tasks/${taskId}/dependencies/${dependencyId}`, { method: 'DELETE' });
}

export async function generatePlanForNewTask(input: {
  title: string;
  description?: string | null;
  workspaceId?: string | null;
}): Promise<PlanStep[]> {
  return request<PlanStep[]>('/api/v1/tasks/generate-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
