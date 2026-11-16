import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { storeToolContent } from './tool-content-store.js';
import { writeToolKeyFile } from '../agents/tools/get-tool-key.tool.js';
import { STUB_THRESHOLD_CHARS } from '../agents/tools/tool-stub.js';

// Per-thread result cache for allowlisted MCP tools (chat-agent.ts's
// mcpToolToLangChain, gated on tool-config.ts's getCacheableToolIds()) — see
// docs/superpowers/specs/2026-11-13-mcp-tool-result-caching-design.md §2/§6.
//
// Deliberately global, keyed by a composite string embedding threadId
// (`${threadId}:${boundName}:${argsHash}`) rather than a nested
// Map<threadId, Map<key, entry>> — this is the simplest structure that
// still gives O(1) get/set per call and easy per-thread filtering for
// eviction/the ledger (both already need to scan "this thread's entries",
// which a flat Map with a prefix check does without a second index).

export interface CacheEntry {
  // Stable for this entry's lifetime — the same kv_ key is returned on every
  // hit and every TTL-driven refresh, never re-minted (the design's "stable
  // identity" rule), so a model that already saw it can reuse it directly.
  kvKey: string;
  // null until the first time this entry's text crosses STUB_THRESHOLD_CHARS
  // with a workspaceLocation bound; stable (same path, overwritten in
  // place) from then on, same reasoning as kvKey.
  diskPath: string | null;
  fetchedAt: number; // epoch ms of the most recent real fetch/refresh
  ttlMs: number;
  toolName: string; // boundName
  args: Record<string, unknown>; // for ledger rendering — the real call args, forceRefresh excluded
}

const _cache = new Map<string, CacheEntry>();

// Recursively sorts object keys so two logically-identical args objects
// (built in a different key order, e.g. by different model providers) hash
// identically — JSON.stringify alone is insertion-order-dependent.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

// forceRefresh is a meta-instruction about THIS call, not part of the
// resource's identity — {workflowId: X, forceRefresh: true} and
// {workflowId: X, forceRefresh: false} (or omitted) must hash identically,
// or forceRefresh would silently create a second, permanently-separate
// cache entry instead of bypassing/refreshing the real one.
function argsHash(args: Record<string, unknown>): string {
  const { forceRefresh: _forceRefresh, ...hashable } = args as { forceRefresh?: boolean } & Record<
    string,
    unknown
  >;
  const sorted = sortKeysDeep(hashable);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 12);
}

function cacheKey(threadId: string, boundName: string, hash: string): string {
  return `${threadId}:${boundName}:${hash}`;
}

export function isMcpToolCacheEnabled(): boolean {
  return env.chat?.mcpToolCache?.enabled !== false;
}

export function getCacheEntry(
  threadId: string,
  boundName: string,
  args: Record<string, unknown>,
): CacheEntry | undefined {
  return _cache.get(cacheKey(threadId, boundName, argsHash(args)));
}

export function isExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt > entry.ttlMs;
}

// threadEntryCap backstop eviction — a count cap alongside TTL, not instead
// of it (TTL is the real staleness signal; this just bounds memory for a
// thread that caches many distinct resources). Evicts the oldest-fetchedAt
// entries for THIS thread only — a refreshed entry's fetchedAt moves
// forward, so repeatedly-used resources naturally outlive untouched ones.
function evictIfOverCapacity(threadId: string, cap: number): void {
  const prefix = `${threadId}:`;
  const threadEntries: [string, CacheEntry][] = [];
  for (const [k, v] of _cache) {
    if (k.startsWith(prefix)) threadEntries.push([k, v]);
  }
  if (threadEntries.length <= cap) return;

  threadEntries.sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
  const surplus = threadEntries.length - cap;
  for (const [k] of threadEntries.slice(0, surplus)) {
    _cache.delete(k);
  }
}

// Decides offload (always, into tool-content-store.ts, same as every other
// MCP tool result) and disk persistence (only when text crosses
// STUB_THRESHOLD_CHARS and a workspaceLocation is bound) in one place, and
// reuses the entry's already-assigned kvKey/diskPath across repeat upserts
// to the same (threadId, boundName, args) rather than minting new ones.
export async function upsertCacheEntry(
  threadId: string,
  boundName: string,
  args: Record<string, unknown>,
  text: string,
  ttlMs: number,
  workspaceLocation: string | undefined,
  // Last param purely for testability (same pattern tool-config.ts uses for
  // env.tools) — production always omits it and takes the configured cap.
  threadEntryCap: number = env.chat?.mcpToolCache?.threadEntryCap ?? 50,
): Promise<CacheEntry> {
  const hash = argsHash(args);
  const key = cacheKey(threadId, boundName, hash);
  const existing = _cache.get(key);

  const kvKey = existing?.kvKey ?? `kv_${randomBytes(4).toString('hex')}`;
  storeToolContent(threadId, kvKey, text);

  let diskPath = existing?.diskPath ?? null;
  if (text.length > STUB_THRESHOLD_CHARS && workspaceLocation) {
    const filename = diskPath ? path.basename(diskPath) : `${boundName}_${hash}.json`;
    const writeResult = await writeToolKeyFile(workspaceLocation, filename, text);
    // writeToolKeyFile never throws — a failure (permission, disk space)
    // comes back as a "Failed to write ..." string instead (see its own
    // comment). Only claim the path on an actual success: the ledger tells
    // the model a resource is "at" this path, and that would be actively
    // wrong — worse than no path at all — if the write never happened.
    if (!writeResult.startsWith('Failed to write ')) {
      diskPath = path.join('.hashbrown', 'tool-key', filename);
    } else {
      logger.warn('mcp-tool-cache: disk write failed, falling back to KV-only for this entry', {
        boundName,
        threadId,
        writeResult,
      });
    }
  }

  const entry: CacheEntry = {
    kvKey,
    diskPath,
    fetchedAt: Date.now(),
    ttlMs,
    toolName: boundName,
    args,
  };
  _cache.set(key, entry);
  evictIfOverCapacity(threadId, threadEntryCap);
  return entry;
}

export function listCacheEntries(threadId: string): CacheEntry[] {
  const prefix = `${threadId}:`;
  const entries: CacheEntry[] = [];
  for (const [k, v] of _cache) {
    if (k.startsWith(prefix)) entries.push(v);
  }
  return entries;
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ');
}

// Deterministic, non-LLM-authored text — regenerated fresh every turn by
// the caller (chat-agent.ts's buildWorkspaceContextBlock call sites), never
// stored in message history, so it can't be trimmed/summarized away. Stale
// entries stay listed (with their location and age) rather than
// disappearing at TTL expiry — the whole point is answering a question
// asked well outside any sane TTL window, which only works if the ledger
// still says where the old copy is.
export function renderCacheLedger(
  threadId: string,
  cap: number = env.chat?.mcpToolCache?.ledgerCap ?? 10,
): string {
  const entries = listCacheEntries(threadId)
    .slice()
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
    .slice(0, cap);
  if (entries.length === 0) return '';

  const lines = entries.map((e) => {
    const ageMs = Date.now() - e.fetchedAt;
    const status = ageMs > e.ttlMs ? `stale (fetched ${formatAge(ageMs)} ago)` : 'fresh';
    const where = e.diskPath ?? `get_tool_key(threadId, "${e.kvKey}")`;
    return `- ${e.toolName}(${summarizeArgs(e.args)}) — ${status}, at ${where}`;
  });

  return [
    'Resources already fetched this thread (do not re-fetch unless you have a specific reason ' +
      'to believe the underlying data changed — a fresh/stale resource marked here is still ' +
      'faster to re-check than a cold fetch):',
    ...lines,
  ].join('\n');
}
