import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { reloadSettingsHandler } from './settings.handlers.js';

describe('routes/v1/settings.handlers', () => {
  describe('reloadSettingsHandler()', () => {
    let calls: string[];

    beforeEach(() => {
      calls = [];
    });

    it('calls config.reload, loadAgentInstructions, invalidateChatAgent, and seedProviderCosts, in that order [orchestration]', async () => {
      const config = {
        reload: () => {
          calls.push('config.reload');
        },
      };
      const loadAgentInstructions = async () => {
        calls.push('loadAgentInstructions');
      };
      const invalidateChatAgent = () => {
        calls.push('invalidateChatAgent');
      };
      const seedProviderCosts = () => {
        calls.push('seedProviderCosts');
      };

      await reloadSettingsHandler(
        config,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );

      expect(calls).to.deep.equal([
        'config.reload',
        'loadAgentInstructions',
        'invalidateChatAgent',
        'seedProviderCosts',
      ]);
    });

    it('calls each dependency exactly once [orchestration]', async () => {
      const counts = { reload: 0, load: 0, invalidate: 0, seed: 0 };

      await reloadSettingsHandler(
        {
          reload: () => {
            counts.reload++;
          },
        },
        async () => {
          counts.load++;
        },
        () => {
          counts.invalidate++;
        },
        () => {
          counts.seed++;
        },
      );

      expect(counts).to.deep.equal({ reload: 1, load: 1, invalidate: 1, seed: 1 });
    });

    it('resolves with { status: "ok" } [unit]', async () => {
      const result = await reloadSettingsHandler(
        { reload: () => {} },
        async () => {},
        () => {},
        () => {},
      );
      expect(result).to.deep.equal({ status: 'ok' });
    });
  });
});
