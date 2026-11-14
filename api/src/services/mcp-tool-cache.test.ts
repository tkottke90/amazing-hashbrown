import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { getToolContent } from './tool-content-store.js';
import { STUB_THRESHOLD_CHARS } from '../agents/tools/tool-stub.js';
import {
  getCacheEntry,
  isExpired,
  upsertCacheEntry,
  listCacheEntries,
  renderCacheLedger,
} from './mcp-tool-cache.js';

// Every test uses its own unique threadId — _cache is a module-level
// singleton with no reset between tests, same convention
// tool-content-store.test.ts already uses for the same reason.

describe('mcp-tool-cache', () => {
  describe('getCacheEntry() / upsertCacheEntry() — hit/miss by args', () => {
    it('misses when nothing has been upserted [unit]', () => {
      expect(getCacheEntry('t-miss', 'n8n__get_workflow_details', { workflowId: 'abc' })).to.equal(
        undefined,
      );
    });

    it('hits with identical args after an upsert [unit]', async () => {
      await upsertCacheEntry('t-hit', 'n8n__get_workflow_details', { workflowId: 'abc' }, 'text', 60000, undefined);
      const hit = getCacheEntry('t-hit', 'n8n__get_workflow_details', { workflowId: 'abc' });
      expect(hit).to.not.equal(undefined);
      expect(hit!.toolName).to.equal('n8n__get_workflow_details');
    });

    it('distinct detailLevel values hash differently and do not collide [unit]', async () => {
      await upsertCacheEntry(
        't-detail',
        'n8n__get_workflow_details',
        { workflowId: 'abc', detailLevel: 'full' },
        'full text',
        60000,
        undefined,
      );
      const missing = getCacheEntry('t-detail', 'n8n__get_workflow_details', {
        workflowId: 'abc',
        detailLevel: 'execution',
      });
      expect(missing).to.equal(undefined);
      const hit = getCacheEntry('t-detail', 'n8n__get_workflow_details', {
        workflowId: 'abc',
        detailLevel: 'full',
      });
      expect(hit).to.not.equal(undefined);
    });

    it('identical tool+args in two different threads do not collide [unit]', async () => {
      await upsertCacheEntry('t-iso-a', 'tool', { id: 1 }, 'thread a value', 60000, undefined);
      await upsertCacheEntry('t-iso-b', 'tool', { id: 1 }, 'thread b value', 60000, undefined);
      const a = getCacheEntry('t-iso-a', 'tool', { id: 1 });
      const b = getCacheEntry('t-iso-b', 'tool', { id: 1 });
      expect(a).to.not.equal(undefined);
      expect(b).to.not.equal(undefined);
      expect(a!.kvKey).to.not.equal(b!.kvKey);
      expect(getToolContent('t-iso-a', a!.kvKey)).to.equal('thread a value');
      expect(getToolContent('t-iso-b', b!.kvKey)).to.equal('thread b value');
    });
  });

  describe('forceRefresh is excluded from the args hash', () => {
    it('identical args with/without forceRefresh resolve to the same cache entry [unit]', async () => {
      await upsertCacheEntry('t-force', 'tool', { workflowId: 'abc' }, 'v1', 60000, undefined);
      const withFlagTrue = getCacheEntry('t-force', 'tool', { workflowId: 'abc', forceRefresh: true });
      const withFlagFalse = getCacheEntry('t-force', 'tool', {
        workflowId: 'abc',
        forceRefresh: false,
      });
      expect(withFlagTrue).to.not.equal(undefined);
      expect(withFlagFalse).to.not.equal(undefined);
      expect(withFlagTrue!.kvKey).to.equal(withFlagFalse!.kvKey);
    });
  });

  describe('isExpired()', () => {
    it('is false immediately after an upsert and true once ttlMs has elapsed [unit]', async () => {
      const entry = await upsertCacheEntry('t-ttl', 'tool', {}, 'text', 10, undefined);
      expect(isExpired(entry)).to.equal(false);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(isExpired(entry)).to.equal(true);
    });
  });

  describe('stable kvKey/diskPath across a refresh (the "stable identity" rule)', () => {
    it('a second upsert to the same (thread, tool, args) reuses the same kvKey, not a new one [unit]', async () => {
      const first = await upsertCacheEntry('t-stable-kv', 'tool', { id: 1 }, 'v1', 60000, undefined);
      const second = await upsertCacheEntry('t-stable-kv', 'tool', { id: 1 }, 'v2', 60000, undefined);
      expect(second.kvKey).to.equal(first.kvKey);
      // The underlying bytes behind that stable key do update, though.
      expect(getToolContent('t-stable-kv', first.kvKey)).to.equal('v2');
    });

    it('a refetch over STUB_THRESHOLD_CHARS reuses the same diskPath and overwrites it in place [unit]', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-tool-cache-test-'));
      try {
        const big1 = 'a'.repeat(STUB_THRESHOLD_CHARS + 10);
        const big2 = 'b'.repeat(STUB_THRESHOLD_CHARS + 10);
        const first = await upsertCacheEntry(
          't-stable-disk',
          'n8n__get_workflow_details',
          { workflowId: 'x' },
          big1,
          60000,
          dir,
        );
        expect(first.diskPath).to.not.equal(null);
        const second = await upsertCacheEntry(
          't-stable-disk',
          'n8n__get_workflow_details',
          { workflowId: 'x' },
          big2,
          60000,
          dir,
        );
        expect(second.diskPath).to.equal(first.diskPath);
        const written = readFileSync(join(dir, first.diskPath!), 'utf8');
        expect(written).to.equal(big2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stays KV-only (no diskPath) when there is no workspaceLocation, even over STUB_THRESHOLD_CHARS [unit]', async () => {
      const big = 'a'.repeat(STUB_THRESHOLD_CHARS + 10);
      const entry = await upsertCacheEntry('t-no-workspace', 'tool', {}, big, 60000, undefined);
      expect(entry.diskPath).to.equal(null);
      expect(getToolContent('t-no-workspace', entry.kvKey)).to.equal(big);
    });

    it('does not claim a diskPath when the disk write actually fails — stays KV-only instead [unit]', async () => {
      // writeToolKeyFile never throws; a failed mkdir/writeFile comes back
      // as a "Failed to write ..." string. Force that by pointing
      // workspaceLocation at a plain FILE, not a directory — mkdir(join(it,
      // '.hashbrown', 'tool-key')) then fails with ENOTDIR.
      const dir = mkdtempSync(join(tmpdir(), 'mcp-tool-cache-fail-test-'));
      const notADirectory = join(dir, 'not-a-directory.txt');
      try {
        writeFileSync(notADirectory, 'not a directory', 'utf8');
        const big = 'a'.repeat(STUB_THRESHOLD_CHARS + 10);
        const entry = await upsertCacheEntry(
          't-disk-fail',
          'n8n__get_workflow_details',
          { workflowId: 'x' },
          big,
          60000,
          notADirectory,
        );
        expect(entry.diskPath).to.equal(null);
        // The KV side still succeeds independently of the disk write.
        expect(getToolContent('t-disk-fail', entry.kvKey)).to.equal(big);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('threadEntryCap eviction (oldest-fetchedAt first, per thread)', () => {
    it('evicts the oldest entry once a thread exceeds the cap [unit]', async () => {
      const threadId = 't-evict';
      // cap of 2, passed as the override param — production reads
      // env.chat.mcpToolCache.threadEntryCap instead.
      await upsertCacheEntry(threadId, 'tool', { id: 1 }, 'v1', 60000, undefined, 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await upsertCacheEntry(threadId, 'tool', { id: 2 }, 'v2', 60000, undefined, 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await upsertCacheEntry(threadId, 'tool', { id: 3 }, 'v3', 60000, undefined, 2);

      expect(listCacheEntries(threadId)).to.have.length(2);
      expect(getCacheEntry(threadId, 'tool', { id: 1 })).to.equal(undefined); // evicted — oldest
      expect(getCacheEntry(threadId, 'tool', { id: 2 })).to.not.equal(undefined);
      expect(getCacheEntry(threadId, 'tool', { id: 3 })).to.not.equal(undefined);
    });

    it('a refreshed entry is not evicted ahead of an untouched older one, since its fetchedAt moves forward [unit]', async () => {
      const threadId = 't-evict-refresh';
      await upsertCacheEntry(threadId, 'tool', { id: 1 }, 'v1', 60000, undefined, 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await upsertCacheEntry(threadId, 'tool', { id: 2 }, 'v1', 60000, undefined, 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Refresh id:1 — it's now the most-recently-fetched, so id:2 (never
      // refreshed) should be the one evicted when id:3 arrives.
      await upsertCacheEntry(threadId, 'tool', { id: 1 }, 'v2', 60000, undefined, 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await upsertCacheEntry(threadId, 'tool', { id: 3 }, 'v1', 60000, undefined, 2);

      expect(getCacheEntry(threadId, 'tool', { id: 1 })).to.not.equal(undefined);
      expect(getCacheEntry(threadId, 'tool', { id: 2 })).to.equal(undefined); // evicted
      expect(getCacheEntry(threadId, 'tool', { id: 3 })).to.not.equal(undefined);
    });

    it('does not evict entries from a different thread [unit]', async () => {
      await upsertCacheEntry('t-evict-other', 'tool', { id: 1 }, 'v1', 60000, undefined, 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await upsertCacheEntry('t-evict-other', 'tool', { id: 2 }, 'v1', 60000, undefined, 1);
      await upsertCacheEntry('t-evict-other-sibling', 'tool', { id: 1 }, 'v1', 60000, undefined, 1);

      expect(getCacheEntry('t-evict-other-sibling', 'tool', { id: 1 })).to.not.equal(undefined);
    });
  });

  describe('renderCacheLedger()', () => {
    it('returns an empty string for a thread with no cached entries [unit]', () => {
      expect(renderCacheLedger('t-ledger-empty')).to.equal('');
    });

    it('lists a fresh entry as "fresh" and a past-TTL entry as "stale", with its location [unit]', async () => {
      const threadId = 't-ledger-fresh-stale';
      await upsertCacheEntry(threadId, 'n8n__get_workflow_details', { workflowId: 'x' }, 'v1', 10, undefined);
      await upsertCacheEntry(
        threadId,
        'n8n__search_workflows',
        { query: 'y' },
        'v2',
        60000,
        undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 25)); // past the 10ms TTL for the first entry

      const ledger = renderCacheLedger(threadId);
      expect(ledger).to.include('stale');
      expect(ledger).to.include('fresh');
      expect(ledger).to.include('n8n__get_workflow_details');
      expect(ledger).to.include('n8n__search_workflows');
    });

    it('caps the number of rendered entries, most-recently-fetched first [unit]', async () => {
      const threadId = 't-ledger-cap';
      for (let i = 0; i < 5; i++) {
        await upsertCacheEntry(threadId, 'tool', { id: i }, `v${i}`, 60000, undefined);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const ledger = renderCacheLedger(threadId, 2);
      // Most recent two: id:4 and id:3 — summarizeArgs renders as "id: 4".
      expect(ledger).to.include('id: 4');
      expect(ledger).to.include('id: 3');
      expect(ledger).to.not.include('id: 0');
    });
  });
});
