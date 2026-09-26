import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppBroadcastEvent } from '@tkottke90/llm-common-types/chat';
import { registerBroadcastClient, unregisterBroadcastClient } from '../../services/broadcast.js';

export const eventsRouter = Router();

const KEEPALIVE_INTERVAL_MS = 20_000;

// Standing app-level SSE channel — one connection per browser tab, opened
// once and kept open for the tab's whole lifetime (see
// ui/src/hooks/use-live-events.ts), unlike every other SSE route in this
// codebase which is scoped to a single POSTed turn. Never calls res.end();
// the connection only ends when the client disconnects (browser tab close,
// navigation away, network drop) or the server shuts down. See
// docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md.
eventsRouter.get('/', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const writer = (event: AppBroadcastEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  registerBroadcastClient(writer);

  // Keeps idle connections from being silently killed by a proxy/browser
  // timeout, which would otherwise force an unnecessary EventSource
  // reconnect — a bare comment line (no `data:`) that EventSource ignores.
  const keepaliveTimer = setInterval(() => {
    res.write(': keepalive\n\n');
  }, KEEPALIVE_INTERVAL_MS);

  // Critical cleanup: EventSource auto-reconnects on drop, so a client that
  // reconnects without this would leave its old writer registered forever,
  // silently accumulating dead entries in the registry across every
  // reconnect/tab-reload.
  req.on('close', () => {
    clearInterval(keepaliveTimer);
    unregisterBroadcastClient(writer);
  });
});
