import { renderHook, act } from '@testing-library/preact';
import { useIsDesktopViewport, useMediaQuery } from '@/hooks/use-media-query';

// jest.setup.ts stubs matchMedia to never match; these tests swap in a fake
// MediaQueryList that records its query and fires change listeners.
function mockMatchMedia(initialMatches: boolean) {
  const listeners: Array<() => void> = [];
  let matches = initialMatches;
  const spy = jest.spyOn(window, 'matchMedia').mockImplementation(
    (media: string) =>
      ({
        get matches() {
          return matches;
        },
        media,
        addEventListener: (_event: string, cb: () => void) => listeners.push(cb),
        removeEventListener: jest.fn(),
      }) as unknown as MediaQueryList,
  );
  return {
    spy,
    fireChange: (next: boolean) => {
      matches = next;
      act(() => listeners.forEach((cb) => cb()));
    },
  };
}

describe('useMediaQuery', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports whether the given query matches [unit]', () => {
    const { spy } = mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1px)'));
    expect(result.current).toBe(true);
    expect(spy).toHaveBeenCalledWith('(min-width: 1px)');
  });

  it('follows the viewport as it crosses the breakpoint [unit]', () => {
    const { fireChange } = mockMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'));

    fireChange(true);

    expect(result.current).toBe(true);
  });

  it('reports desktop chrome only at 1024px and wider [unit]', () => {
    const { spy } = mockMatchMedia(true);
    renderHook(() => useIsDesktopViewport());
    expect(spy).toHaveBeenCalledWith('(min-width: 1024px)');
  });
});
