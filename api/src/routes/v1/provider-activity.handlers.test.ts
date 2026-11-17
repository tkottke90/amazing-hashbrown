import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ProviderQueue } from '../../services/provider-queue.js';
import { getProviderActivityHandler } from './provider-activity.handlers.js';

describe('routes/v1/provider-activity.handlers', () => {
  describe('getProviderActivityHandler', () => {
    it('returns a snapshot per requested provider, including one with no activity', async () => {
      const queue = new ProviderQueue((name) => ({ ollama: 2, anthropic: 4 })[name] ?? 1);
      await queue.acquireSlot('ollama', 'sync', {
        caller: { threadId: 't1', kind: 'task', label: 'Task: Sync pricing' },
      });

      const result = getProviderActivityHandler(queue, ['ollama', 'anthropic']);

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data).to.deep.equal([
        {
          provider: 'ollama',
          maxConcurrency: 2,
          active: [{ threadId: 't1', kind: 'task', label: 'Task: Sync pricing' }],
          waiting: [],
        },
        { provider: 'anthropic', maxConcurrency: 4, active: [], waiting: [] },
      ]);
    });
  });
});
