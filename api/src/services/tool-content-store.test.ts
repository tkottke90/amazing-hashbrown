import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import {
  storeToolContent,
  getToolContent,
  storeBinaryToolContent,
  getToolContentEntry,
  _resetToolContentStoreForTests,
} from './tool-content-store.js';

describe('tool-content-store', () => {
  it('round-trips text content through storeToolContent/getToolContent [unit]', () => {
    storeToolContent('thread-a', 'key-1', 'hello world');

    expect(getToolContent('thread-a', 'key-1')).to.equal('hello world');
  });

  it('getToolContent returns undefined for a key stored as binary [unit]', () => {
    storeBinaryToolContent('thread-b', 'key-2', 'artifact-1');

    expect(getToolContent('thread-b', 'key-2')).to.equal(undefined);
  });

  it('round-trips a binary entry through storeBinaryToolContent/getToolContentEntry [unit]', () => {
    storeBinaryToolContent('thread-c', 'key-3', 'artifact-2');

    expect(getToolContentEntry('thread-c', 'key-3')).to.deep.equal({
      kind: 'binary',
      attachmentId: 'artifact-2',
    });
  });

  it('getToolContentEntry returns a text-kind entry for a text-stored key [unit]', () => {
    storeToolContent('thread-d', 'key-4', 'some text');

    expect(getToolContentEntry('thread-d', 'key-4')).to.deep.equal({
      kind: 'text',
      content: 'some text',
    });
  });

  it('getToolContentEntry returns undefined for an unknown threadId/toolKey pair [unit]', () => {
    expect(getToolContentEntry('thread-does-not-exist', 'key-does-not-exist')).to.equal(undefined);
  });

  it('isolates the same toolKey stored under two different threadIds [unit]', () => {
    storeToolContent('thread-e', 'shared-key', 'content for thread e');
    storeBinaryToolContent('thread-f', 'shared-key', 'artifact-for-thread-f');

    expect(getToolContent('thread-e', 'shared-key')).to.equal('content for thread e');
    expect(getToolContentEntry('thread-f', 'shared-key')).to.deep.equal({
      kind: 'binary',
      attachmentId: 'artifact-for-thread-f',
    });
  });

  describe('count-cap eviction (no TTL — see this file for why)', () => {
    // Eviction is global (not per-thread), so a capacity assertion needs a
    // known-empty store — unlike every other test in this file, which only
    // needs its own unique thread/key names to stay isolated.
    beforeEach(() => {
      _resetToolContentStoreForTests();
    });

    it('evicts the oldest-inserted entry once the store exceeds maxEntries [unit]', () => {
      storeToolContent('thread-cap', 'key-1', 'v1', 2);
      storeToolContent('thread-cap', 'key-2', 'v2', 2);
      storeToolContent('thread-cap', 'key-3', 'v3', 2);

      expect(getToolContent('thread-cap', 'key-1')).to.equal(undefined); // evicted — oldest
      expect(getToolContent('thread-cap', 'key-2')).to.equal('v2');
      expect(getToolContent('thread-cap', 'key-3')).to.equal('v3');
    });

    it('does not evict while at or under maxEntries [unit]', () => {
      storeToolContent('thread-cap-ok', 'key-1', 'v1', 2);
      storeToolContent('thread-cap-ok', 'key-2', 'v2', 2);

      expect(getToolContent('thread-cap-ok', 'key-1')).to.equal('v1');
      expect(getToolContent('thread-cap-ok', 'key-2')).to.equal('v2');
    });

    it('eviction applies across storeToolContent and storeBinaryToolContent — one shared cap [unit]', () => {
      storeToolContent('thread-cap-mixed', 'key-1', 'v1', 1);
      storeBinaryToolContent('thread-cap-mixed', 'key-2', 'artifact-1', 1);

      expect(getToolContent('thread-cap-mixed', 'key-1')).to.equal(undefined); // evicted
      expect(getToolContentEntry('thread-cap-mixed', 'key-2')).to.deep.equal({
        kind: 'binary',
        attachmentId: 'artifact-1',
      });
    });

    // Regression guard: this store has no freshness concept, unlike
    // mcp-tool-cache.ts's TTL-bounded cache — nothing here should ever
    // expire an entry just because time passed.
    it('never expires an entry by age alone, no matter how long ago it was stored [unit]', async () => {
      storeToolContent('thread-no-ttl', 'key-1', 'still here', 500);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getToolContent('thread-no-ttl', 'key-1')).to.equal('still here');
    });
  });
});
