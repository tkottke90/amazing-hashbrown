import { act, renderHook } from '@testing-library/preact';

import { replaceHash, setHash, useUrlHash } from '@/hooks/use-hash';

function setLocationHash(hash: string) {
  window.location.hash = hash;
}

describe('useUrlHash', () => {
  afterEach(() => {
    setLocationHash('');
  });

  it('reads the current URL hash (without the leading #) on mount', () => {
    setLocationHash('#tasks');

    const { result } = renderHook(() => useUrlHash());

    expect(result.current.value).toBe('tasks');
  });

  it('updates when a hashchange event fires', () => {
    const { result } = renderHook(() => useUrlHash());
    expect(result.current.value).toBe('');

    act(() => {
      setLocationHash('#files');
      window.dispatchEvent(new Event('hashchange'));
    });

    expect(result.current.value).toBe('files');
  });

  it('stops updating once unmounted', () => {
    const { result, unmount } = renderHook(() => useUrlHash());
    unmount();

    act(() => {
      setLocationHash('#chat');
      window.dispatchEvent(new Event('hashchange'));
    });

    expect(result.current.value).toBe('');
  });
});

describe('setHash', () => {
  afterEach(() => {
    setLocationHash('');
  });

  it('assigns the URL hash directly', () => {
    setHash('overview');

    expect(window.location.hash).toBe('#overview');
  });
});

describe('replaceHash', () => {
  afterEach(() => {
    setLocationHash('');
  });

  it('updates the hash via history.replaceState instead of assigning location.hash', () => {
    const replaceStateSpy = jest.spyOn(window.history, 'replaceState');

    replaceHash('overview');

    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    const [, , url] = replaceStateSpy.mock.calls[0]!;
    expect(new URL(url as string, window.location.href).hash).toBe('#overview');

    replaceStateSpy.mockRestore();
  });

  it('does not add a browser history entry', () => {
    const lengthBefore = window.history.length;

    replaceHash('overview');

    expect(window.history.length).toBe(lengthBefore);
  });
});
