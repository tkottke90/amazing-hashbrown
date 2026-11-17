jest.mock('@/hooks/use-providers', () => ({
  ...jest.requireActual('@/hooks/use-providers'),
  fetchProviders: jest.fn(),
}));

jest.mock('@/hooks/use-provider-activity', () => ({
  ...jest.requireActual('@/hooks/use-provider-activity'),
  fetchProviderActivity: jest.fn(),
}));

import { render, screen, within } from '@testing-library/preact';
import { ProviderActivityMonitor } from '@/pages/monitoring/provider-activity-monitor';
import { providers, defaultProviderName } from '@/hooks/use-providers';
import { providerActivityState } from '@/hooks/use-provider-activity';
import { queueState } from '@/hooks/use-tasks';
import type { ProviderInfo } from '@/hooks/use-providers';
import type { ProviderActivitySnapshot } from '@tkottke90/llm-common-types/chat';
import type { Task } from '@/services/tasks-api';

function provider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return { name: 'ollama', type: 'ollama', models: [], maxConcurrency: 2, ...overrides };
}

function snapshot(overrides: Partial<ProviderActivitySnapshot> = {}): ProviderActivitySnapshot {
  return { provider: 'ollama', maxConcurrency: 2, active: [], waiting: [], ...overrides };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: null,
    title: 'Sync vendor pricing sheet',
    description: null,
    outcome: null,
    status: 'ready',
    assignedTo: 'agent',
    dueAt: null,
    expiresAt: null,
    triggerType: 'manual',
    triggerConfig: null,
    trackerType: null,
    trackerId: null,
    plan: null,
    blockedReason: null,
    provider: 'ollama',
    model: null,
    archivedAt: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  };
}

function queueEntry(t: Task) {
  return {
    id: `q-${t.id}`,
    taskId: t.id,
    status: 'pending' as const,
    position: 0,
    enqueuedAt: '2026-11-16T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    recoveryAttempts: 0,
    threadId: null,
    summary: null,
    triggerSource: 'manual' as const,
    scheduledFor: null,
    handoffReason: null,
    task: t,
  };
}

describe('pages/monitoring/ProviderActivityMonitor', () => {
  beforeEach(() => {
    providers.value = [];
    defaultProviderName.value = 'ollama';
    providerActivityState.value = [];
    queueState.value = { queue: [], running: [] };
  });

  it('shows an empty state when no providers are configured [unit]', () => {
    render(<ProviderActivityMonitor />);
    expect(screen.getByText('No providers configured.')).toBeInTheDocument();
  });

  it('renders one dot per active caller and one outline dot per free slot [unit]', () => {
    providers.value = [provider({ name: 'ollama', maxConcurrency: 3 })];
    providerActivityState.value = [
      snapshot({
        provider: 'ollama',
        maxConcurrency: 3,
        active: [{ threadId: 't-1', kind: 'chat', label: 'Chat: Untitled' }],
      }),
    ];

    render(<ProviderActivityMonitor />);

    const bar = screen.getByTestId('provider-bar');
    expect(within(bar).getByTitle('Chat: Untitled')).toBeInTheDocument();
    expect(within(bar).getAllByTitle('Free')).toHaveLength(2);
    expect(within(bar).getByText('1/3')).toBeInTheDocument();
  });

  it("lists a ready task's chip on its Pinned Provider's Green Room lane, as draggable [unit]", () => {
    providers.value = [provider({ name: 'ollama' })];
    const t = task({ status: 'ready', provider: 'ollama' });
    queueState.value = { queue: [queueEntry(t)], running: [] };

    render(<ProviderActivityMonitor />);

    const chip = screen.getByTestId('green-room-chip-ready');
    expect(chip).toHaveTextContent('Task: Sync vendor pricing sheet');
  });

  it('lists a real waiting caller as a non-draggable chip [unit]', () => {
    providers.value = [provider({ name: 'ollama' })];
    providerActivityState.value = [
      snapshot({
        provider: 'ollama',
        waiting: [{ threadId: 't-2', kind: 'workspace-chat', label: 'Workspace: Billing' }],
      }),
    ];

    render(<ProviderActivityMonitor />);

    expect(screen.getByTestId('green-room-chip-live')).toHaveTextContent('Workspace: Billing');
    expect(screen.queryByTestId('green-room-chip-ready')).not.toBeInTheDocument();
  });

  it('shows an empty lane marker when a provider has nothing waiting [unit]', () => {
    providers.value = [provider({ name: 'ollama' })];

    render(<ProviderActivityMonitor />);

    const lane = screen.getByTestId('green-room-lane');
    expect(within(lane).getByText('—')).toBeInTheDocument();
  });
});
