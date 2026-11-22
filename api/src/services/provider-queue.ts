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
  syncQueue: QueuedRequest[];
  asyncQueue: QueuedRequest[];
  // One entry per currently-held slot — length IS the active count, not
  // merely kept equal to it. A real CallerIdentity for an acquire that
  // passed one, an `undefined` placeholder for one that didn't (every real
  // call site passes one today; the type stays optional because
  // provider-queue.test.ts's own concurrency-mechanics tests — slot counts,
  // drain ordering — deliberately exercise acquireSlot/releaseSlot without
  // one, and shouldn't have to fabricate caller identities to do it).
  activeHolders: (CallerIdentity | undefined)[];
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
// resume across a restart, so activeHolders/queues simply start empty.
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
        syncQueue: [],
        asyncQueue: [],
        activeHolders: [],
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

    if (gate.activeHolders.length < gate.maxConcurrency) {
      gate.activeHolders.push(opts.caller);
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

    // Removes the one entry this release actually corresponds to — a
    // threadId match for a named caller, the first anonymous placeholder
    // otherwise — rather than decrementing a counter and separately
    // popping whatever's last. A release with nothing matching it (not
    // expected from any real call site) is a true no-op: it must not free
    // a slot nobody holding a match actually vacated.
    const idx = caller
      ? gate.activeHolders.findIndex((c) => c?.threadId === caller.threadId)
      : gate.activeHolders.findIndex((c) => c === undefined);
    if (idx !== -1) gate.activeHolders.splice(idx, 1);

    this.drainGate(gate);
    this.emitActivity();
  }

  // Promotes queued requests into held slots while capacity allows — sync
  // ahead of async, every iteration (not just the first pop), so a burst of
  // async completions can't let a later-arriving sync request get skipped
  // over mid-drain. Shared by releaseSlot (a slot just freed) and
  // refreshLimits (maxConcurrency just grew) — either can open up capacity
  // for more than one queued request at once.
  private drainGate(gate: ProviderGate): void {
    while (
      gate.activeHolders.length < gate.maxConcurrency &&
      (gate.syncQueue.length > 0 || gate.asyncQueue.length > 0)
    ) {
      const next = gate.syncQueue.length > 0 ? gate.syncQueue.shift()! : gate.asyncQueue.shift()!;
      gate.activeHolders.push(next.caller);
      next.cleanupAbort?.();
      next.onWaitChange?.(false);
      next.resolve();
    }
  }

  // Re-resolves maxConcurrency for every gate created so far, against the
  // live config — called after a Settings reload so an edited limit takes
  // effect without a restart, instead of the gate enforcing whatever number
  // was live the moment it was first created. Always re-resolves, even for
  // a gate currently (or newly) at -1: a provider must be able to move
  // into/out of "unlimited" at runtime the same as any other concurrency
  // edit, or this reintroduces the exact staleness bug for that one value.
  // Draining is skipped only when the new value is -1, since nothing can
  // ever be queued against an unlimited gate. One broadcast after the whole
  // pass, not one per gate — a reload is a single event; an open Monitoring
  // page should see one consistent post-reload snapshot, not N partial ones.
  refreshLimits(): void {
    for (const [name, gate] of this.gates) {
      gate.maxConcurrency = this.resolveMaxConcurrency(name);
      if (gate.maxConcurrency !== -1) this.drainGate(gate);
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
      active: gate.activeHolders.filter((caller): caller is CallerIdentity => caller !== undefined),
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
