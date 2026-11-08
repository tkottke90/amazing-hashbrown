import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { storeToolContent } from '../../services/tool-content-store.js';
import { makeGetToolKeyTool } from './get-tool-key.tool.js';

describe('agents/tools/get-tool-key', () => {
  describe('makeGetToolKeyTool() — restricted schema (no workspace)', () => {
    it('returns the stored content for a matching threadId and toolKey', async () => {
      storeToolContent('thread-1', 'kv_abc123', 'The full article text.');

      const result = await makeGetToolKeyTool().invoke({
        threadId: 'thread-1',
        toolKey: 'kv_abc123',
      });

      expect(result).to.equal('The full article text.');
    });

    it('returns a not-found message for a toolKey that was never stored', async () => {
      const result = await makeGetToolKeyTool().invoke({
        threadId: 'thread-2',
        toolKey: 'kv_missing',
      });

      expect(result).to.be.a('string');
      expect(result as unknown as string).to.include('KV content not found');
      expect(result as unknown as string).to.include('thread-2');
      expect(result as unknown as string).to.include('kv_missing');
    });

    it('returns a not-found message when the toolKey exists under a different threadId', async () => {
      storeToolContent('thread-3', 'kv_def456', 'Scoped to thread-3 only.');

      const result = await makeGetToolKeyTool().invoke({
        threadId: 'thread-4',
        toolKey: 'kv_def456',
      });

      expect(result as unknown as string).to.include('KV content not found');
    });

    it('allows the same key to be read more than once (non-destructive read)', async () => {
      storeToolContent('thread-5', 'kv_ghi789', 'Read me twice.');

      const first = await makeGetToolKeyTool().invoke({
        threadId: 'thread-5',
        toolKey: 'kv_ghi789',
      });
      const second = await makeGetToolKeyTool().invoke({
        threadId: 'thread-5',
        toolKey: 'kv_ghi789',
      });

      expect(first).to.equal('Read me twice.');
      expect(second).to.equal('Read me twice.');
    });

    it('returns stored content unchanged when offset/limit are omitted (default, no regression)', async () => {
      const content = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
      storeToolContent('thread-6', 'kv_default', content);

      const result = await makeGetToolKeyTool().invoke({
        threadId: 'thread-6',
        toolKey: 'kv_default',
      });

      expect(result).to.equal(content);
    });

    it('returns stored content unchanged for offset: 0 explicitly with no limit', async () => {
      const content = 'a\nb\nc';
      storeToolContent('thread-6b', 'kv_default2', content);

      const result = await makeGetToolKeyTool().invoke({
        threadId: 'thread-6b',
        toolKey: 'kv_default2',
        offset: 0,
      });

      expect(result).to.equal(content);
    });

    it('returns an empty-string stored value unchanged, distinct from not-found', async () => {
      storeToolContent('thread-7', 'kv_empty', '');

      const result = await makeGetToolKeyTool().invoke({
        threadId: 'thread-7',
        toolKey: 'kv_empty',
      });

      expect(result).to.equal('');
    });

    it('returns a mid-document slice with a lines header when offset/limit are given', async () => {
      const content = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
      storeToolContent('thread-8', 'kv_slice', content);

      const result = (await makeGetToolKeyTool().invoke({
        threadId: 'thread-8',
        toolKey: 'kv_slice',
        offset: 2,
        limit: 3,
      })) as unknown as string;

      expect(result).to.equal('[lines 2-4 of 10 total]\nline 2\nline 3\nline 4');
    });

    it('returns everything from offset to the end when limit exceeds the remaining lines', async () => {
      const content = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
      storeToolContent('thread-9', 'kv_overlimit', content);

      const result = (await makeGetToolKeyTool().invoke({
        threadId: 'thread-9',
        toolKey: 'kv_overlimit',
        offset: 3,
        limit: 100,
      })) as unknown as string;

      expect(result).to.equal('[lines 3-4 of 5 total]\nline 3\nline 4');
    });

    it('reports no lines at an offset past the end of the content', async () => {
      const content = 'a\nb\nc';
      storeToolContent('thread-10', 'kv_pastend', content);

      const result = (await makeGetToolKeyTool().invoke({
        threadId: 'thread-10',
        toolKey: 'kv_pastend',
        offset: 50,
      })) as unknown as string;

      expect(result).to.equal('[No lines at offset 50 — this content has 3 lines.]');
    });

    it('has no filename field in its schema at all — not just undocumented', () => {
      const restricted = makeGetToolKeyTool();
      expect(restricted.schema.shape).to.not.have.property('filename');
    });
  });

  describe('makeGetToolKeyTool(workspaceLocation) — full schema (workspace)', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('has a filename field in its schema', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'get-tool-key-'));
      const full = makeGetToolKeyTool(tmpDir);
      expect(full.schema.shape).to.have.property('filename');
    });

    it('writes content to .hashbrown/tool-key/<filename> and returns a confirmation without the content itself', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'get-tool-key-'));
      storeToolContent('thread-20', 'kv_write1', 'line a\nline b\nline c');

      const result = (await makeGetToolKeyTool(tmpDir).invoke({
        threadId: 'thread-20',
        toolKey: 'kv_write1',
        filename: 'notes.md',
      })) as unknown as string;

      expect(result).to.include('.hashbrown/tool-key/notes.md');
      expect(result).to.include('3 lines');
      expect(result).to.not.include('line a');

      const written = readFileSync(join(tmpDir, '.hashbrown', 'tool-key', 'notes.md'), 'utf8');
      expect(written).to.equal('line a\nline b\nline c');
    });

    it('writes only the offset/limit-sliced portion when both filename and a slice are given together', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'get-tool-key-'));
      const content = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
      storeToolContent('thread-21', 'kv_write2', content);

      await makeGetToolKeyTool(tmpDir).invoke({
        threadId: 'thread-21',
        toolKey: 'kv_write2',
        offset: 2,
        limit: 2,
        filename: 'slice.md',
      });

      const written = readFileSync(join(tmpDir, '.hashbrown', 'tool-key', 'slice.md'), 'utf8');
      expect(written).to.equal('[lines 2-3 of 10 total]\nline 2\nline 3');
    });

    it('overwrites an existing file silently when the same filename is written twice', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'get-tool-key-'));
      storeToolContent('thread-22', 'kv_write3a', 'first version');
      storeToolContent('thread-22b', 'kv_write3b', 'second version');

      await makeGetToolKeyTool(tmpDir).invoke({
        threadId: 'thread-22',
        toolKey: 'kv_write3a',
        filename: 'ref.md',
      });
      await makeGetToolKeyTool(tmpDir).invoke({
        threadId: 'thread-22b',
        toolKey: 'kv_write3b',
        filename: 'ref.md',
      });

      const written = readFileSync(join(tmpDir, '.hashbrown', 'tool-key', 'ref.md'), 'utf8');
      expect(written).to.equal('second version');
    });

    it('rejects a filename containing a path separator at the schema level', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'get-tool-key-'));
      const schema = makeGetToolKeyTool(tmpDir).schema;

      expect(() =>
        schema.parse({ threadId: 'thread-23', toolKey: 'kv_write4', filename: 'a/b.txt' }),
      ).to.throw();
    });

    it('rejects a filename of exactly ".." at the schema level', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'get-tool-key-'));
      const schema = makeGetToolKeyTool(tmpDir).schema;

      expect(() =>
        schema.parse({ threadId: 'thread-24', toolKey: 'kv_write5', filename: '..' }),
      ).to.throw();
    });

    it('rejects a filename of exactly "." at the schema level', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'get-tool-key-'));
      const schema = makeGetToolKeyTool(tmpDir).schema;

      expect(() =>
        schema.parse({ threadId: 'thread-25', toolKey: 'kv_write6', filename: '.' }),
      ).to.throw();
    });

    it('returns a Failed-to-write message instead of throwing when the write itself fails', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'get-tool-key-'));
      storeToolContent('thread-26', 'kv_write7', 'content');

      // Force mkdir(..., {recursive:true}) to fail: put a plain file where
      // the .hashbrown/tool-key directory needs to be created.
      mkdirSync(join(tmpDir, '.hashbrown'));
      writeFileSync(join(tmpDir, '.hashbrown', 'tool-key'), 'not a directory');

      const result = (await makeGetToolKeyTool(tmpDir).invoke({
        threadId: 'thread-26',
        toolKey: 'kv_write7',
        filename: 'ref.md',
      })) as unknown as string;

      expect(result).to.include('Failed to write .hashbrown/tool-key/ref.md');
    });
  });
});
