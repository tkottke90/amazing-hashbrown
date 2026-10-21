import { render, screen, waitFor, cleanup } from '@testing-library/preact';

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

import { ChatRoot } from '@/pages/chat';
import { _resetThreadInstancesForTests } from '@/hooks/use-thread';

const ARCHIVED_THREAD = 'archived-thread-1';

// What GET /api/v1/threads/:id returns for an archived chat thread. The
// sidebar's own GET /api/v1/threads (no id) excludes it server-side (D13),
// so that fetch returns an empty list — ChatRoot's fast path
// (threads.value.some(...)) must not find it there.
const archivedThreadResponse = {
  id: ARCHIVED_THREAD,
  title: 'Old project planning',
  type: 'chat',
  archivedAt: '2026-10-01T00:00:00.000Z',
  messages: [],
};

const originalFetch = global.fetch;

beforeEach(() => {
  mockPath = `/chat/${ARCHIVED_THREAD}`;
  // URL-aware, not a blanket mock: ChatRoot renders the full sidebar (via
  // Layout), whose own background effects (refreshQueue, fetchTasks) also
  // call `fetch` on mount and expect array/object shapes of their own —
  // answering every call with the single thread object corrupts those
  // signals and crashes a later render (the exact "Jest worker encountered
  // child process exceptions" failure this is guarding against), rather
  // than failing an assertion cleanly.
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/threads') {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    if (url === `/api/v1/threads/${ARCHIVED_THREAD}`) {
      return Promise.resolve({ ok: true, json: async () => archivedThreadResponse });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  _resetThreadInstancesForTests();
  jest.clearAllMocks();
  global.fetch = originalFetch;
});

describe('ChatRoot — archived-thread routing', () => {
  it('renders ArchivedThreadView, not the normal chat view, for an archived thread [unit]', async () => {
    render(<ChatRoot id={ARCHIVED_THREAD} />);

    await waitFor(() => expect(screen.getByTestId('archived-thread-view')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText(/message/i)).not.toBeInTheDocument();
  });
});
