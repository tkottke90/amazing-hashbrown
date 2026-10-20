import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/preact';

import { ThreadSidebar, clampThreads } from '@/components/thread-sidebar';
import { threads, type ThreadSummary } from '@/hooks/use-thread';

function makeThread(id: string): ThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    forkedFromThreadId: null,
    forkedFromSeq: null,
    type: 'chat',
    afterAgentState: { status: 'idle' },
    links: {
      self: `/api/v1/threads/${id}`,
      afterAgentStatus: `/api/v1/threads/${id}/after-agent-status`,
    },
    provider: null,
    model: null,
    archivedAt: null,
  };
}

// jsdom returns an all-zero rect from getBoundingClientRect by default, so
// the mobile clamp (which sizes itself off the thread container's real
// height) is stubbed here per-test — the same pattern
// use-is-mobile-viewport.test.tsx uses for matchMedia.
function mockMatchMedia(matches: boolean) {
  jest.spyOn(window, 'matchMedia').mockReturnValue({
    matches,
    media: '(max-width: 639px)',
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as unknown as MediaQueryList);
}

function mockContainerHeight(height: number) {
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    height,
    width: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => {},
  } as DOMRect);
}

describe('clampThreads', () => {
  const five = Array.from({ length: 5 }, (_, i) => makeThread(`t-${i}`));

  it('returns every thread when maxCount is 0 or negative', () => {
    expect(clampThreads(five, 0)).toEqual(five);
    expect(clampThreads(five, -1)).toEqual(five);
  });

  it('slices to maxCount when it is positive and below the thread count', () => {
    expect(clampThreads(five, 3)).toEqual(five.slice(0, 3));
  });

  it('returns every thread when maxCount is at or above the thread count', () => {
    expect(clampThreads(five, 5)).toEqual(five);
    expect(clampThreads(five, 10)).toEqual(five);
  });
});

describe('ThreadSidebar mobile thread clamping', () => {
  afterEach(() => {
    threads.value = [];
    jest.restoreAllMocks();
  });

  it('clamps the visible threads to what the container can fit on a mobile viewport', () => {
    threads.value = Array.from({ length: 5 }, (_, i) => makeThread(`t-${i}`));
    mockMatchMedia(true);
    // (height - 54) / 54, floored — 216 fits exactly 3 rows.
    mockContainerHeight(216);

    const { container } = render(<ThreadSidebar />);

    expect(container.querySelectorAll('[data-slot="thread-row"]')).toHaveLength(3);
  });

  it('renders every thread on a desktop viewport regardless of container height', () => {
    threads.value = Array.from({ length: 5 }, (_, i) => makeThread(`t-${i}`));
    mockMatchMedia(false);
    mockContainerHeight(216);

    const { container } = render(<ThreadSidebar />);

    expect(container.querySelectorAll('[data-slot="thread-row"]')).toHaveLength(5);
  });
});

// jsdom has no `onpointerdown` IDL property, so Preact falls back to
// registering pointer listeners under the un-lowercased event name — needed
// to actually open Radix's pointerdown-driven menus in jsdom. Mirrors
// dropdown-menu-portal.test.tsx's own helper.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

describe('ThreadRow dropdown — Archive', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    cleanup();
    threads.value = [];
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('archives a thread with one click, no confirmation step [unit]', async () => {
    const thread = makeThread('t-1');
    threads.value = [thread];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...thread, archivedAt: '2026-10-20T00:00:00.000Z' }),
    }) as unknown as typeof fetch;

    render(<ThreadSidebar />);

    firePointerDown(screen.getByRole('button', { name: `Options for ${thread.title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        `/api/v1/threads/${thread.id}/archive`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    // No "Archive this thread?" confirmation text anywhere — unlike Delete.
    expect(screen.queryByText(/archive this thread/i)).not.toBeInTheDocument();
  });
});

describe('ThreadSidebar Dashboard link', () => {
  // The global preact-iso mock (test/__mocks__/preact-iso.tsx) returns
  // url: '/' by default, so the active-state assertions here need no
  // per-test override — see thread-sidebar-dashboard-link.test.tsx for the
  // inactive-elsewhere case, which does need a different url.
  it('renders a Dashboard link pointing at / [unit]', () => {
    render(<ThreadSidebar />);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
  });

  it('marks the Dashboard link active when url is / [unit]', () => {
    render(<ThreadSidebar />);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveClass('bg-sidebar-accent');
    expect(screen.getByRole('link', { name: 'Inbox' })).not.toHaveClass('bg-sidebar-accent');
  });
});
