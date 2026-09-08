import { describe, it } from 'mocha';
import { expect } from 'chai';
import { storeToolContent } from '../../services/tool-content-store.js';
import { getToolKeyTool } from './get-tool-key.tool.js';

describe('agents/tools/get-tool-key', () => {
  it('returns the stored content for a matching threadId and toolKey', async () => {
    storeToolContent('thread-1', 'kv_abc123', 'The full article text.');

    const result = await getToolKeyTool.invoke({ threadId: 'thread-1', toolKey: 'kv_abc123' });

    expect(result).to.equal('The full article text.');
  });

  it('returns a not-found message for a toolKey that was never stored', async () => {
    const result = await getToolKeyTool.invoke({ threadId: 'thread-2', toolKey: 'kv_missing' });

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('KV content not found');
    expect(result as unknown as string).to.include('thread-2');
    expect(result as unknown as string).to.include('kv_missing');
  });

  it('returns a not-found message when the toolKey exists under a different threadId', async () => {
    storeToolContent('thread-3', 'kv_def456', 'Scoped to thread-3 only.');

    const result = await getToolKeyTool.invoke({ threadId: 'thread-4', toolKey: 'kv_def456' });

    expect(result as unknown as string).to.include('KV content not found');
  });

  it('allows the same key to be read more than once (non-destructive read)', async () => {
    storeToolContent('thread-5', 'kv_ghi789', 'Read me twice.');

    const first = await getToolKeyTool.invoke({ threadId: 'thread-5', toolKey: 'kv_ghi789' });
    const second = await getToolKeyTool.invoke({ threadId: 'thread-5', toolKey: 'kv_ghi789' });

    expect(first).to.equal('Read me twice.');
    expect(second).to.equal('Read me twice.');
  });
});
