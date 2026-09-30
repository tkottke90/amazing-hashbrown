import { render } from '@testing-library/preact';

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
