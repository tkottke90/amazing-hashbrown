import { logger } from '../config/logger.js';
import { getThreadStore } from '../services/thread-store.js';
import { getWakeupStore, type Wakeup, type WakeupFireSource } from '../services/wakeup-store.js';
import { runHeadlessTurn } from './headless-turn.js';
import { resolveThreadAgent } from './resolve-thread-agent.js';
import { enqueuePendingTurn } from './pending-thread-turns.js';

// "45s", "15m", "1h 5m" — coarse on purpose; the agent only needs a sense
// of how much time passed.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

// The message a fired wake-up resumes the agent with: its own note, how long
// ago it was scheduled, and why it fired when it did if that wasn't its
// timer (triggered early by the user, or late after server downtime).
export function buildWakeupMessage(
  wakeup: Wakeup,
  settledBy: WakeupFireSource,
  lateByMs: number,
  now: Date,
): string {
  const ago = formatElapsed(now.getTime() - new Date(wakeup.createdAt).getTime());
  const lines = [`⏰ Wake-up (scheduled ${ago} ago). Your note: "${wakeup.note}"`];
  if (settledBy === 'trigger_now') {
    lines.push('The user triggered this wake-up early.');
  } else if (settledBy === 'catch_up' && lateByMs > 0) {
    lines.push(`This fired ${formatElapsed(lateByMs)} late because the server was offline.`);
  }
  lines.push('Continue from where you left off.');
  return lines.join('\n');
}

export interface WakeupDeliveryDeps {
  resolveAgent?: typeof resolveThreadAgent;
  runTurn?: typeof runHeadlessTurn;
  now?: () => Date;
}

// WakeupRegistry's deliverer: resumes the wake-up's thread as a headless
// turn, queued behind any turn already running there. Writes the
// wakeup_fired marker when the turn actually starts, so it sits directly
// above the reply. The registry doesn't await it (fire-and-forget); the
// returned promise settles once the turn is queued or started, for tests.
// Never rejects. See docs/superpowers/specs/2026-09-27-agent-wait-design.md §3.
export async function deliverWakeup(
  wakeup: Wakeup,
  settledBy: WakeupFireSource,
  lateByMs: number,
  deps: WakeupDeliveryDeps = {},
): Promise<void> {
  const resolveAgent = deps.resolveAgent ?? resolveThreadAgent;
  const runTurn = deps.runTurn ?? runHeadlessTurn;
  const message = buildWakeupMessage(
    wakeup,
    settledBy,
    lateByMs,
    (deps.now ?? (() => new Date()))(),
  );
  try {
    const resolved = await resolveAgent(wakeup.threadId);
    if (!resolved) return;
    enqueuePendingTurn(wakeup.threadId, async () => {
      getWakeupStore().recordFiredMarker(wakeup, settledBy, lateByMs);
      await runTurn({
        threadId: wakeup.threadId,
        agent: resolved.agent,
        message,
        threadStore: getThreadStore(),
        workspaceId: resolved.workspaceId,
        taskId: resolved.taskId,
        provider: resolved.provider,
        model: resolved.model,
        source: 'wakeup',
        wakeupDepth: wakeup.chainDepth,
      });
    });
  } catch (err) {
    logger.error('wakeup-delivery: failed to deliver wake-up', {
      wakeupId: wakeup.id,
      threadId: wakeup.threadId,
      err: String(err),
    });
  }
}
