import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/preact';

const mockRoute = jest.fn();
let mockPath = '/';

jest.mock('preact-iso', () => ({
  ...jest.requireActual('preact-iso'),
  useLocation: () => ({ url: mockPath, path: mockPath, query: {}, route: mockRoute }),
}));

jest.mock('@/lib/sse', () => ({
  ...jest.requireActual('@/lib/sse'),
  consumeSsePost: jest.fn().mockResolvedValue(undefined),
}));

import * as sse from '@/lib/sse';
import { TaskRunView } from '@/pages/chat/task-run-view';
import { TaskRunMarkerMessage } from '@/components/task-run-marker-message';
import { HitlPromptMessage } from '@/components/hitl-prompt-message';
import { useThreadInstance, _resetThreadInstancesForTests } from '@/hooks/use-thread';
import type { HitlThreadMessage, TaskRunMarkerThreadMessage } from '@/types/thread-message';

const RUN_THREAD = 'run-thread-1';

// What GET /api/v1/threads/:id returns for an automated run's thread.
const runThreadResponse = {
  id: RUN_THREAD,
  title: 'Audit — run #3',
  type: 'task',
  taskRun: {
    taskId: 'task-1',
    taskTitle: 'Weekly audit',
    workspaceId: null,
    runId: 'run-3',
    runNumber: 3,
    status: 'paused',
    triggerSource: 'schedule',
  },
  messages: [
    {
      id: 'm1',
      kind: 'assistant',
      seq: 1,
      status: 'error',
      content: 'Tried something',
      sentAt: '2026-09-26T00:00:00.000Z',
    },
    {
      id: 'p1',
      kind: 'hitl_prompt',
      seq: 2,
      status: 'pending',
      promptId: 'p1',
      question: 'Which registry should I audit?',
      promptKind: 'free_text',
      taskId: 'task-1',
    },
  ],
};

const originalFetch = global.fetch;

beforeEach(() => {
  mockPath = `/chat/${RUN_THREAD}`;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => runThreadResponse,
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  _resetThreadInstancesForTests();
  jest.clearAllMocks();
  global.fetch = originalFetch;
});

async function renderRunView() {
  await useThreadInstance(RUN_THREAD).hydrate();
  render(<TaskRunView threadId={RUN_THREAD} />);
}

describe('TaskRunView — read-only record of an automated run', () => {
  it('names the run, its task, status and what started it [unit]', async () => {
    await renderRunView();
    expect(screen.getByTestId('task-run-title')).toHaveTextContent(
      'Scheduled run #3 of Weekly audit',
    );
    expect(screen.getByTestId('task-run-status')).toHaveTextContent('paused');
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('offers no way to write into the run: no message box, no retry [unit]', async () => {
    await renderRunView();
    expect(screen.queryByRole('textbox', { name: /message/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('task-run-readonly-note')).toBeInTheDocument();
  });

  it("keeps the run's own question answerable, through the task-aware chat /hitl route [unit]", async () => {
    await renderRunView();
    expect(screen.getByText('Which registry should I audit?')).toBeInTheDocument();

    fireEvent.input(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: 'npm' },
    });
    const submit = screen.getByRole('button', { name: 'Submit' });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() =>
      expect(sse.consumeSsePost).toHaveBeenCalledWith(
        `/api/v1/chat/${RUN_THREAD}/hitl`,
        expect.objectContaining({ promptId: 'p1', answer: 'npm' }),
        expect.any(Function),
        expect.anything(),
      ),
    );
  });

  it('links back to the Inbox for a run of an Inbox task [unit]', async () => {
    await renderRunView();
    screen.getByTestId('task-run-back').click();
    expect(mockRoute).toHaveBeenCalledWith('/inbox');
  });
});

describe('TaskRunMarkerMessage — run links', () => {
  const marker: TaskRunMarkerThreadMessage = {
    kind: 'task_run_marker',
    id: 'mk',
    taskId: 'task-1',
    taskTitle: 'Weekly audit',
    phase: 'end',
    outcome: 'done',
    runThreadId: RUN_THREAD,
    runNumber: 12,
    triggerSource: 'schedule',
  };

  it('labels the run and links to it from the workspace chat [unit]', () => {
    mockPath = '/workspaces/ws-1';
    render(<TaskRunMarkerMessage message={marker} />);
    expect(screen.getByTestId('task-run-marker')).toHaveTextContent(
      'Scheduled run #12 of task completed: Weekly audit',
    );
    screen.getByTestId('task-run-marker-open').click();
    expect(mockRoute).toHaveBeenCalledWith(`/chat/${RUN_THREAD}`);
  });

  it('does not link to the run from inside that run [unit]', () => {
    render(<TaskRunMarkerMessage message={marker} />);
    expect(screen.queryByTestId('task-run-marker-open')).not.toBeInTheDocument();
  });

  it('keeps the old wording for markers recorded before runs had numbers [unit]', () => {
    const legacy: TaskRunMarkerThreadMessage = {
      kind: 'task_run_marker',
      id: 'mk-old',
      taskId: 'task-1',
      taskTitle: 'Weekly audit',
      phase: 'end',
      outcome: 'done',
    };
    render(<TaskRunMarkerMessage message={legacy} />);
    expect(screen.getByTestId('task-run-marker')).toHaveTextContent(
      'Automated task completed: Weekly audit',
    );
  });
});

describe('HitlPromptMessage — copied task question', () => {
  const prompt: HitlThreadMessage = {
    kind: 'hitl_prompt',
    id: 'copy',
    promptId: 'copy',
    question: 'Deploy now?',
    promptKind: 'yes_no',
    status: 'pending',
    taskId: 'task-1',
    runThreadId: RUN_THREAD,
  };

  it('links a copied question to the run that asked it [unit]', () => {
    render(<HitlPromptMessage message={prompt} onAnswer={() => {}} />);
    screen.getByTestId('hitl-open-run').click();
    expect(mockRoute).toHaveBeenCalledWith(`/chat/${RUN_THREAD}`);
  });

  it('shows no run link on an ordinary chat question [unit]', () => {
    const plain: HitlThreadMessage = {
      kind: 'hitl_prompt',
      id: 'chat-q',
      promptId: 'chat-q',
      question: 'Deploy now?',
      promptKind: 'yes_no',
      status: 'pending',
    };
    render(<HitlPromptMessage message={plain} onAnswer={() => {}} />);
    expect(screen.queryByTestId('hitl-open-run')).not.toBeInTheDocument();
  });
});
