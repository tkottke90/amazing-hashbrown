import type { Response } from 'express';

// How often an idle per-turn SSE stream gets a keepalive comment. Well under
// the idle timeouts browsers and proxies apply to a response that sends no
// bytes (Firefox drops one after ~5 minutes), which is what a long tool call
// — or a `sleep` in shell_exec — otherwise produces.
export const SSE_KEEPALIVE_MS = 15_000;

export interface SseKeepaliveDeps {
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

// Writes an SSE comment line (`: keepalive`) on an interval for the life of
// one per-turn stream. Clients ignore comment lines — consumeSsePost only
// reads `data:` lines — so this only keeps the connection from looking idle.
// Returns a stop function; also stops itself when the client disconnects.
// Call right after setSseHeaders() and stop in the route's finally block.
// See docs/superpowers/specs/2026-09-27-agent-wait-design.md §1.
export function startSseKeepalive(res: Response, deps: SseKeepaliveDeps = {}): () => void {
  const intervalMs = deps.intervalMs ?? SSE_KEEPALIVE_MS;
  const set = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear =
    deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let stopped = false;
  const handle = set(() => {
    if (!stopped && !res.writableEnded) res.write(': keepalive\n\n');
  }, intervalMs);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clear(handle);
  };
  res.on('close', stop);
  return stop;
}
