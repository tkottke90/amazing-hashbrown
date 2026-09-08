import { renderHook, act } from '@testing-library/preact';
import { useIsMobileViewport } from '@/hooks/use-is-mobile-viewport';

// ui/jest.setup.ts globally stubs window.matchMedia to always report
// `matches: false` with no-op addEventListener/removeEventListener, so
// every test that needs the mobile branch (or a live `change` event) must
// override it per-test with a fake MediaQueryList whose addEventListener
// actually records listeners.
function mockMatchMedia(initialMatches: boolean) {
  const listeners: Array<() => void> = [];
  let matches = initialMatches;
  const mql = {
    get matches() {
      return matches;
    },
    media: '(max-width: 639px)',
    addEventListener: (_event: string, cb: () => void) => listeners.push(cb),
    removeEventListener: jest.fn(),
  };
  jest.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);
  return {
    fireChange: (next: boolean) => {
      matches = next;
      act(() => listeners.forEach((cb) => cb()));
    },
  };
}

describe('useIsMobileViewport', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns false (desktop) under the default matchMedia stub', () => {
    const { result } = renderHook(() => useIsMobileViewport());
    expect(result.current).toBe(false);
  });

  it('returns true when matchMedia reports a mobile-width match', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useIsMobileViewport());
    expect(result.current).toBe(true);
  });

  it('updates when the media query change fires', () => {
    const { fireChange } = mockMatchMedia(false);
    const { result } = renderHook(() => useIsMobileViewport());
    expect(result.current).toBe(false);

    fireChange(true);

    expect(result.current).toBe(true);
  });
});
