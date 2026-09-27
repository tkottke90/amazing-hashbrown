import { logger } from '../config/logger.js';
import {
  getWakeupStore,
  type Wakeup,
  type WakeupStore,
  type WakeupCancelSource,
  type WakeupFireSource,
} from './wakeup-store.js';

// Starts the turn a fired wake-up resumes. lateByMs is how long after its
// fire time it actually fired (non-zero only for a catch-up after downtime).
export type WakeupDeliverer = (
  wakeup: Wakeup,
  settledBy: WakeupFireSource,
  lateByMs: number,
) => void | Promise<void>;

export interface WakeupRegistryDeps {
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  store?: () => WakeupStore;
  // Required — the real one (agents/wakeup-delivery.ts) pulls in the agent
  // tree, which this module deliberately doesn't import.
  deliver: WakeupDeliverer;
}

interface ArmedTimer {
  handle: unknown;
  threadId: string;
  fireAt: Date;
}

// One in-process timer per pending wake-up, modelled on CronRegistry: the
// database is the source of truth and a timer is only a wake-up call —
// every fire re-reads the row and settles it through WakeupStore, whose
// pending-only transitions decide whether the fire happens. The 2 h delay
// cap (WAKEUP_MAX_DELAY_S) keeps every delay far below setTimeout's 32-bit
// limit, so no chunking. See
// docs/superpowers/specs/2026-09-27-agent-wait-design.md §3.
export class WakeupRegistry {
  private readonly timers = new Map<string, ArmedTimer>();
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly store: () => WakeupStore;
  private readonly deliver: WakeupDeliverer;

  constructor(deps: WakeupRegistryDeps) {
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.store = deps.store ?? getWakeupStore;
    this.deliver = deps.deliver;
  }

  // Arms every pending wake-up; one that came due while the server was down
  // fires once, now, flagged as a catch-up with its lateness.
  boot(): void {
    let pending: Wakeup[] = [];
    try {
      pending = this.store().listPending();
    } catch (err) {
      logger.error('wakeup-registry: boot failed to list pending wake-ups', { err: String(err) });
    }
    for (const wakeup of pending) {
      if (new Date(wakeup.fireAt).getTime() <= this.now().getTime()) {
        this.fire(wakeup.id, 'catch_up');
      } else {
        this.arm(wakeup);
      }
    }
    logger.info('wakeup-registry: booted', { armed: this.timers.size });
  }

  // Re-reads the wake-up and (re-)arms its timer, or clears it when it is no
  // longer pending. Call after scheduling. Never throws.
  sync(wakeupId: string): void {
    this.clear(wakeupId);
    try {
      const wakeup = this.store().get(wakeupId);
      if (!wakeup || wakeup.status !== 'pending') return;
      if (new Date(wakeup.fireAt).getTime() <= this.now().getTime()) {
        this.fire(wakeupId, 'timer');
        return;
      }
      this.arm(wakeup);
    } catch (err) {
      logger.error('wakeup-registry: sync failed', { wakeupId, err: String(err) });
    }
  }

  // The card's "Trigger now". Null when the wake-up is no longer pending.
  triggerNow(wakeupId: string): Wakeup | null {
    this.clear(wakeupId);
    return this.fire(wakeupId, 'trigger_now');
  }

  // The card's "Cancel" and the agent's cancel_wakeup. Null when the
  // wake-up is no longer pending.
  cancel(wakeupId: string, by: WakeupCancelSource, reason?: string): Wakeup | null {
    this.clear(wakeupId);
    try {
      return this.store().cancel(wakeupId, by, reason);
    } catch (err) {
      logger.error('wakeup-registry: cancel failed', { wakeupId, err: String(err) });
      return null;
    }
  }

  // Drops the timers of a deleted thread (its rows already cascaded away).
  clearThread(threadId: string): void {
    for (const [wakeupId, armed] of [...this.timers.entries()]) {
      if (armed.threadId === threadId) this.clear(wakeupId);
    }
  }

  // Settles the wake-up as fired and starts its turn. Returns null — and
  // does nothing — unless the wake-up is still pending (a cancel won the
  // race, or it already fired). Never throws.
  fire(wakeupId: string, source: WakeupFireSource): Wakeup | null {
    let fired: Wakeup | null;
    try {
      const current = this.store().get(wakeupId);
      if (!current || current.status !== 'pending') return null;
      const lateByMs = this.now().getTime() - new Date(current.fireAt).getTime();
      if (source === 'timer' && lateByMs < 0) {
        // Early wake (timer drift) — just re-arm.
        this.arm(current);
        return null;
      }
      fired = this.store().markFired(wakeupId, source);
      if (!fired) return null;
      logger.info('wakeup-registry: fired', { wakeupId, threadId: fired.threadId, source });
      // Not awaited: delivery resolves an agent and queues a turn, which
      // must not hold up the caller (a route, boot, or a timer callback).
      void this.deliver(fired, source, source === 'catch_up' ? Math.max(0, lateByMs) : 0);
    } catch (err) {
      logger.error('wakeup-registry: fire failed', { wakeupId, err: String(err) });
      return null;
    }
    return fired;
  }

  // The fire time a wake-up is currently armed for (diagnostics/tests).
  armedFor(wakeupId: string): Date | null {
    return this.timers.get(wakeupId)?.fireAt ?? null;
  }

  stop(): void {
    for (const wakeupId of [...this.timers.keys()]) this.clear(wakeupId);
  }

  private arm(wakeup: Wakeup): void {
    this.clear(wakeup.id);
    const fireAt = new Date(wakeup.fireAt);
    const delay = Math.max(0, fireAt.getTime() - this.now().getTime());
    const handle = this.setTimer(() => {
      this.timers.delete(wakeup.id);
      this.fire(wakeup.id, 'timer');
    }, delay);
    this.timers.set(wakeup.id, { handle, threadId: wakeup.threadId, fireAt });
  }

  private clear(wakeupId: string): void {
    const armed = this.timers.get(wakeupId);
    if (!armed) return;
    this.clearTimer(armed.handle);
    this.timers.delete(wakeupId);
  }
}

// ---------------------------------------------------------------------------
// Boot wiring — mirrors cron-registry.ts
// ---------------------------------------------------------------------------

let _registry: WakeupRegistry | null = null;

export function bootWakeupRegistry(deps: WakeupRegistryDeps): WakeupRegistry {
  _registry?.stop();
  _registry = new WakeupRegistry(deps);
  _registry.boot();
  return _registry;
}

export function getWakeupRegistry(): WakeupRegistry {
  if (!_registry) {
    throw new Error('Wake-up registry not initialised — call bootWakeupRegistry() first');
  }
  return _registry;
}
