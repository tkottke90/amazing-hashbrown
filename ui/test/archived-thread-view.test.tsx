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
import { ArchivedThreadView } from '@/pages/chat/archived-thread-view';
import { useThreadInstance, _resetThreadInstancesForTests } from '@/hooks/use-thread';

const ARCHIVED_THREAD = 'archived-thread-1';

// What GET /api/v1/threads/:id returns for an archived chat thread.
const archivedThreadResponse = {
  id: ARCHIVED_THREAD,
  title: 'Old project planning',
  type: 'chat',
  archivedAt: '2026-10-01T00:00:00.000Z',
  messages: [
    {
      id: 'm1',
      kind: 'user',
      seq: 1,
      content: 'What should we build next?',
      sentAt: '2026-09-26T00:00:00.000Z',
    },
    {
      id: 'm2',
      kind: 'assistant',
      seq: 2,
      status: 'done',
      content: 'Here are some ideas…',
      sentAt: '2026-09-26T00:00:05.000Z',
    },
    {
      id: 'p1',
      kind: 'hitl_prompt',
      seq: 3,
      status: 'pending',
      promptId: 'p1',
      question: 'Should I proceed?',
      promptKind: 'free_text',
    },
  ],
};

const originalFetch = global.fetch;

beforeEach(() => {
  mockPath = `/chat/${ARCHIVED_THREAD}`;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => archivedThreadResponse,
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  _resetThreadInstancesForTests();
  jest.clearAllMocks();
  global.fetch = originalFetch;
});

async function renderArchivedView() {
  await useThreadInstance(ARCHIVED_THREAD).hydrate();
  render(<ArchivedThreadView threadId={ARCHIVED_THREAD} />);
}

describe('ArchivedThreadView — read-only record of an archived chat thread', () => {
  it('names the thread using its own title, not run-specific metadata [unit]', async () => {
    await renderArchivedView();
    expect(screen.getByTestId('archived-thread-title')).toHaveTextContent('Old project planning');
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('renders the thread history [unit]', async () => {
    await renderArchivedView();
    expect(screen.getByText('What should we build next?')).toBeInTheDocument();
    expect(screen.getByText('Here are some ideas…')).toBeInTheDocument();
  });

  it('offers no way to write into the thread: no message box, no retry, no fork [unit]', async () => {
    await renderArchivedView();
    expect(screen.queryByRole('textbox', { name: /message/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/message/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('archived-thread-readonly-note')).toBeInTheDocument();
  });

  it('still wires a pending prompt to submitHitlAnswer, structurally — the backend 409s the actual POST [unit]', async () => {
    await renderArchivedView();
    expect(screen.getByText('Should I proceed?')).toBeInTheDocument();

    fireEvent.input(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: 'yes' },
    });
    const submit = screen.getByRole('button', { name: 'Submit' });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() =>
      expect(sse.consumeSsePost).toHaveBeenCalledWith(
        `/api/v1/chat/${ARCHIVED_THREAD}/hitl`,
        expect.objectContaining({ promptId: 'p1', answer: 'yes' }),
        expect.any(Function),
        expect.anything(),
      ),
    );
  });

  it("uses the browser's back navigation [unit]", async () => {
    const backSpy = jest.spyOn(window.history, 'back').mockImplementation(() => {});
    await renderArchivedView();

    screen.getByTestId('archived-thread-back').click();

    expect(backSpy).toHaveBeenCalled();
    backSpy.mockRestore();
  });

  it('offers a Generate thread report button that opens the report URL [unit]', async () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    await renderArchivedView();

    fireEvent.click(screen.getByTitle('Generate thread report'));

    expect(openSpy).toHaveBeenCalledWith(`/api/v1/threads/${ARCHIVED_THREAD}/report`, '_blank');
    openSpy.mockRestore();
  });
});
