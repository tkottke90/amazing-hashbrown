import { act, render } from '@testing-library/preact';

import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';

let intersectionCallback: IntersectionObserverCallback | null = null;
let resizeCallback: ResizeObserverCallback | null = null;

class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function fireIntersecting(isIntersecting: boolean) {
  act(() => {
    intersectionCallback?.(
      [{ isIntersecting } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

function fireResize() {
  act(() => {
    resizeCallback?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
  });
}

// The wrapper suppresses its ResizeObserver-driven follow-scroll until two
// animation frames after mount (see chat-message-scroll-wrapper.tsx's
// isInitializedRef guard). Wait for that to clear so resize-follow tests
// exercise the real sentinel/near-bottom logic rather than this unrelated gate.
async function waitForInitialLayoutGuard() {
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

describe('ChatMessageScrollWrapper', () => {
  let scrollToSpy: jest.Mock;

  beforeEach(() => {
    intersectionCallback = null;
    resizeCallback = null;
    globalThis.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    scrollToSpy = jest.fn();
    Element.prototype.scrollTo = scrollToSpy;
  });

  it('does not call scrollTo on initial mount', () => {
    render(
      <ChatMessageScrollWrapper forceScrollTrigger={0}>
        <div>message</div>
      </ChatMessageScrollWrapper>,
    );

    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it('forces a smooth scroll to bottom when forceScrollTrigger changes, even if the sentinel was not intersecting', () => {
    const { rerender } = render(
      <ChatMessageScrollWrapper forceScrollTrigger={0}>
        <div>message</div>
      </ChatMessageScrollWrapper>,
    );

    // User has scrolled away from the bottom before submitting again
    fireIntersecting(false);

    rerender(
      <ChatMessageScrollWrapper forceScrollTrigger={1}>
        <div>message</div>
      </ChatMessageScrollWrapper>,
    );

    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });

  it('keeps following a subsequent resize growth event after a forced scroll', async () => {
    const { rerender } = render(
      <ChatMessageScrollWrapper forceScrollTrigger={0}>
        <div>message</div>
      </ChatMessageScrollWrapper>,
    );
    await waitForInitialLayoutGuard();

    fireIntersecting(false);

    rerender(
      <ChatMessageScrollWrapper forceScrollTrigger={1}>
        <div>message</div>
      </ChatMessageScrollWrapper>,
    );
    scrollToSpy.mockClear();

    // Streamed content keeps growing after the forced scroll re-armed sticking
    fireResize();

    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });

  it('does not scroll on content growth once the sentinel reports the user scrolled away', async () => {
    render(
      <ChatMessageScrollWrapper forceScrollTrigger={0}>
        <div>message</div>
      </ChatMessageScrollWrapper>,
    );
    await waitForInitialLayoutGuard();

    fireIntersecting(false);
    scrollToSpy.mockClear();

    fireResize();

    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});
