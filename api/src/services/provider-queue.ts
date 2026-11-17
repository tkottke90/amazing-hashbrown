import type { AppBroadcastEvent, ProviderActivitySnapshot } from '@tkottke90/llm-common-types/chat';
import { resolveProviderConfig } from './provider-factory.js';
import { env } from '../config/env.js';
import { broadcast } from './broadcast.js';
import type { CallerIdentity } from './caller-identity.js';

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
  // Who's asking — carried through to the Provider Activity Monitor
  // (GLOSSARY.md § Monitoring) so a slot or a wait can be attributed to a
  // thread. Omitted only by code that predates this feature; every real
  // call site passes one.
  caller?: CallerIdentity;
}

interface QueuedRequest {
  resolve: () => void;
  reject: (err: Error) => void;
  kind: RequestKind;
  onWaitChange?: (waiting: boolean) => void;
  cleanupAbort?: () => void;
  caller?: CallerIdentity;
}

interface ProviderGate {
  maxConcurrency: number;
  activeCount: number;
  syncQueue: QueuedRequest[];
  asyncQueue: QueuedRequest[];
  // Parallel to activeCount — whoever currently holds a slot. Only entries
  // with a `caller` ever appear here, so this can be shorter than
  // activeCount for a call site that predates this feature.
  activeCallers: CallerIdentity[];
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
        activeCallers: [],
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
      if (opts.caller) gate.activeCallers.push(opts.caller);
      this.emitActivity();
      return Promise.resolve();
    }

    opts.onWaitChange?.(true);

    return new Promise<void>((resolve, reject) => {
      const queue = kind === 'sync' ? gate.syncQueue : gate.asyncQueue;
      const entry: QueuedRequest = {
        resolve,
        reject,
        kind,
        onWaitChange: opts.onWaitChange,
        caller: opts.caller,
      };

      if (opts.signal) {
        const onAbort = () => {
          const idx = queue.indexOf(entry);
          if (idx === -1) return; // already dispatched — abort arrived too late to matter
          queue.splice(idx, 1);
          entry.onWaitChange?.(false);
          this.emitActivity();
          reject(new Error(`Aborted while waiting for provider "${providerName}" capacity`));
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanupAbort = () => opts.signal!.removeEventListener('abort', onAbort);
      }

      queue.push(entry);
      this.emitActivity();
    });
  }

  releaseSlot(providerName: string, caller?: CallerIdentity): void {
    const gate = this.getGate(providerName);
    if (gate.maxConcurrency === -1) return;

    gate.activeCount--;
    if (caller) {
      const idx = gate.activeCallers.findIndex((c) => c.threadId === caller.threadId);
      if (idx !== -1) gate.activeCallers.splice(idx, 1);
    } else {
      // No caller to match against — only possible for a call site that
      // predates this feature. Pop so activeCallers.length never drifts
      // from activeCount; every real call site passes caller, so this is a
      // documented fallback, not a path anything today actually takes.
      gate.activeCallers.pop();
    }

    while (
      gate.activeCount < gate.maxConcurrency &&
      (gate.syncQueue.length > 0 || gate.asyncQueue.length > 0)
    ) {
      const next = gate.syncQueue.length > 0 ? gate.syncQueue.shift()! : gate.asyncQueue.shift()!;
      gate.activeCount++;
      if (next.caller) gate.activeCallers.push(next.caller);
      next.cleanupAbort?.();
      next.onWaitChange?.(false);
      next.resolve();
    }

    this.emitActivity();
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
      this.releaseSlot(providerName, opts.caller);
    }
  }

  // Introspection for the Provider Activity Monitor (GLOSSARY.md §
  // Monitoring) — safe/idempotent even for a provider name with no gate
  // created yet, mirroring getGate's own lazy-create.
  getGateSnapshot(providerName: string): ProviderActivitySnapshot {
    const gate = this.getGate(providerName);
    return {
      provider: providerName,
      maxConcurrency: gate.maxConcurrency,
      active: gate.activeCallers,
      waiting: [...gate.syncQueue, ...gate.asyncQueue]
        .map((entry) => entry.caller)
        .filter((caller): caller is CallerIdentity => caller !== undefined),
    };
  }

  getAllGateSnapshots(providerNames: string[]): ProviderActivitySnapshot[] {
    return providerNames.map((name) => this.getGateSnapshot(name));
  }

  // Fired on every acquire/release/abort — the only mutation points of gate
  // state — so an open Provider Activity Monitor stays live with no
  // polling. Pools every configured provider (not just ones with current
  // activity) plus any provider a gate happens to already exist for.
  private emitActivity(): void {
    const names = new Set<string>(env.providers.map((p) => p.name));
    for (const name of this.gates.keys()) names.add(name);
    broadcast({
      type: 'provider_activity_update',
      providers: this.getAllGateSnapshots([...names]),
    } as unknown as AppBroadcastEvent);
  }
}

let _queue: ProviderQueue | null = null;

export function getProviderQueue(): ProviderQueue {
  if (!_queue) {
    _queue = new ProviderQueue();
  }
  return _queue;
}
