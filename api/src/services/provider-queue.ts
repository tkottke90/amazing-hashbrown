import { resolveProviderConfig } from './provider-factory.js';

export type RequestKind = 'sync' | 'async';

export interface AcquireSlotOptions {
  signal?: AbortSignal;
  // Fired synchronously with `true` the moment a request is queued (never
  // called at all if a slot was available immediately), and with `false`
  // once it's dispatched or its wait ends via abort. Callers with a live
  // user watching (interactive chat/workspace-chat turns) use this to emit
  // the `provider_wait` SSE event; task runs pass nothing, since no one is
  // watching a task's own turn (see design doc §6).
  onWaitChange?: (waiting: boolean) => void;
}

interface QueuedRequest {
  resolve: () => void;
  reject: (err: Error) => void;
  kind: RequestKind;
  onWaitChange?: (waiting: boolean) => void;
  cleanupAbort?: () => void;
}

interface ProviderGate {
  maxConcurrency: number;
  activeCount: number;
  syncQueue: QueuedRequest[];
  asyncQueue: QueuedRequest[];
}

// Reads a provider's configured maxConcurrency from the live env config,
// defaulting to 1 (today's de-facto single-flight behavior) when unset, and
// to -1 (unlimited — never gate a provider nobody configured a limit for)
// when the provider name can't be resolved at all.
function resolveMaxConcurrencyFromEnv(providerName: string): number {
  try {
    return resolveProviderConfig(providerName).maxConcurrency ?? 1;
  } catch {
    return -1;
  }
}

// One gate per configured provider name, in-memory only — see design doc
// §4: a slot claim's lifetime is one outbound request, nothing meaningful to
// resume across a restart, so activeCount/queues simply start empty.
//
// `resolveMaxConcurrency` is injected (defaulting to the real env-resolving
// implementation above) so unit tests can drive gate sizing directly,
// mirroring createProviderFromConfig()'s pure/env-resolving split.
export class ProviderQueue {
  private gates = new Map<string, ProviderGate>();
  private resolveMaxConcurrency: (providerName: string) => number;

  constructor(
    resolveMaxConcurrency: (providerName: string) => number = resolveMaxConcurrencyFromEnv,
  ) {
    this.resolveMaxConcurrency = resolveMaxConcurrency;
  }

  private getGate(providerName: string): ProviderGate {
    let gate = this.gates.get(providerName);
    if (!gate) {
      gate = {
        maxConcurrency: this.resolveMaxConcurrency(providerName),
        activeCount: 0,
        syncQueue: [],
        asyncQueue: [],
      };
      this.gates.set(providerName, gate);
    }
    return gate;
  }

  acquireSlot(
    providerName: string,
    kind: RequestKind,
    opts: AcquireSlotOptions = {},
  ): Promise<void> {
    const gate = this.getGate(providerName);

    if (gate.maxConcurrency === -1) {
      return Promise.resolve();
    }

    if (gate.activeCount < gate.maxConcurrency) {
      gate.activeCount++;
      return Promise.resolve();
    }

    opts.onWaitChange?.(true);

    return new Promise<void>((resolve, reject) => {
      const queue = kind === 'sync' ? gate.syncQueue : gate.asyncQueue;
      const entry: QueuedRequest = { resolve, reject, kind, onWaitChange: opts.onWaitChange };

      if (opts.signal) {
        const onAbort = () => {
          const idx = queue.indexOf(entry);
          if (idx === -1) return; // already dispatched — abort arrived too late to matter
          queue.splice(idx, 1);
          entry.onWaitChange?.(false);
          reject(new Error(`Aborted while waiting for provider "${providerName}" capacity`));
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanupAbort = () => opts.signal!.removeEventListener('abort', onAbort);
      }

      queue.push(entry);
    });
  }

  releaseSlot(providerName: string): void {
    const gate = this.getGate(providerName);
    if (gate.maxConcurrency === -1) return;

    gate.activeCount--;

    while (
      gate.activeCount < gate.maxConcurrency &&
      (gate.syncQueue.length > 0 || gate.asyncQueue.length > 0)
    ) {
      const next = gate.syncQueue.length > 0 ? gate.syncQueue.shift()! : gate.asyncQueue.shift()!;
      gate.activeCount++;
      next.cleanupAbort?.();
      next.onWaitChange?.(false);
      next.resolve();
    }
  }

  // Convenience wrapper used at every real call site — acquires, runs `fn`,
  // and always releases, even if `fn` throws or the acquire itself rejects
  // (in which case there is nothing to release, so releaseSlot is skipped).
  async withSlot<T>(
    providerName: string,
    kind: RequestKind,
    fn: () => Promise<T>,
    opts: AcquireSlotOptions = {},
  ): Promise<T> {
    await this.acquireSlot(providerName, kind, opts);
    try {
      return await fn();
    } finally {
      this.releaseSlot(providerName);
    }
  }
}

let _queue: ProviderQueue | null = null;

export function getProviderQueue(): ProviderQueue {
  if (!_queue) {
    _queue = new ProviderQueue();
  }
  return _queue;
}
