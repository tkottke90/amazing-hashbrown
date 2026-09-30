import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

function readHash() {
  return window.location.hash.slice(1);
}

export function useUrlHash() {
  const hash = useSignal(readHash());

  useEffect(() => {
    const eventListener = new AbortController();

    window.addEventListener('hashchange', () => (hash.value = readHash()), {
      signal: eventListener.signal,
    });

    return () => eventListener.abort();
  }, []);

  return hash;
}

export function setHash(newHash: string) {
  window.location.hash = newHash;
}

// Updates the URL hash without adding a browser history entry — for
// establishing a default tab on load, where a back-button stop would be
// surprising.
export function replaceHash(newHash: string) {
  const url = new URL(window.location.href);
  url.hash = newHash;
  window.history.replaceState(window.history.state, '', url);
}
