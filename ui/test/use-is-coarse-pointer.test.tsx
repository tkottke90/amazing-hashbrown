import { renderHook } from '@testing-library/preact';
import { useIsCoarsePointer } from '@/hooks/use-is-coarse-pointer';

// ui/jest.setup.ts globally stubs window.matchMedia to always report
// `matches: false`, so the desktop (non-coarse) case needs no setup at all.
// The coarse-pointer case overrides it per-test — simpler than
// use-is-mobile-viewport.test.tsx's mock, since this one-shot hook never
// calls addEventListener and has no live "fireChange" to simulate.
describe('useIsCoarsePointer', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns false under the default matchMedia stub (desktop)', () => {
    const { result } = renderHook(() => useIsCoarsePointer());
    expect(result.current).toBe(false);
  });

  it('returns true when matchMedia reports a coarse-pointer match', () => {
    jest.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(pointer: coarse)',
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    } as unknown as MediaQueryList);

    const { result } = renderHook(() => useIsCoarsePointer());
    expect(result.current).toBe(true);
  });

  it('queries the (pointer: coarse) media feature', () => {
    const spy = jest.spyOn(window, 'matchMedia');
    renderHook(() => useIsCoarsePointer());
    expect(spy).toHaveBeenCalledWith('(pointer: coarse)');
  });
});
