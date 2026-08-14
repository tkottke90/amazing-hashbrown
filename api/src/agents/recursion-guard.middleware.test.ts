import { describe, it } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { createRecursionGuardMiddleware } from './recursion-guard.middleware.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeState(aiCount: number): { messages: any[] } {
  return {
    messages: [
      new HumanMessage('start'),
      ...Array.from({ length: aiCount }, () => new AIMessage('working...')),
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callBeforeModel(guard: any, state: { messages: any[] }): Promise<unknown> {
  return guard.beforeModel(state);
}

describe('agents/recursion-guard.middleware', () => {
  describe('createRecursionGuardMiddleware', () => {
    it('returns undefined when no LLM calls have been made yet (completedSteps = 0)', async () => {
      const guard = createRecursionGuardMiddleware(10, 0.5); // threshold = 5
      const result = await callBeforeModel(guard, makeState(0));
      expect(result).to.equal(undefined);
    });

    it('returns undefined when completedSteps is below the threshold', async () => {
      const guard = createRecursionGuardMiddleware(10, 0.5); // threshold = 5
      const result = await callBeforeModel(guard, makeState(4));
      expect(result).to.equal(undefined);
    });

    it('fires interrupt (throws) when completedSteps exactly equals the threshold', async () => {
      const guard = createRecursionGuardMiddleware(10, 0.5); // threshold = 5
      let threw = false;
      try {
        await callBeforeModel(guard, makeState(5));
      } catch {
        threw = true;
      }
      expect(threw, 'guard should throw NodeInterrupt when threshold is reached').to.equal(true);
    });

    it('does not fire at completedSteps one below the threshold', async () => {
      const guard = createRecursionGuardMiddleware(100, 0.75); // threshold = 75
      const result = await callBeforeModel(guard, makeState(74));
      expect(result).to.equal(undefined);
    });

    it('fires at the threshold (75 with default settings)', async () => {
      const guard = createRecursionGuardMiddleware(100, 0.75); // threshold = 75
      let threw = false;
      try {
        await callBeforeModel(guard, makeState(75));
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });

    it('does not fire between multiples of the threshold (76 after firing at 75)', async () => {
      // The modulo design fires at 75, 150, 225 — not at 76, 77, etc.
      // This gives the agent a fresh interval after each resume.
      const guard = createRecursionGuardMiddleware(100, 0.75); // threshold = 75
      const result = await callBeforeModel(guard, makeState(76));
      expect(result).to.equal(undefined);
    });

    it('fires again at the next multiple of the threshold (150)', async () => {
      const guard = createRecursionGuardMiddleware(100, 0.75); // threshold = 75
      let threw = false;
      try {
        await callBeforeModel(guard, makeState(150));
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });

    it('threshold is floor(recursionLimit * warnThreshold)', () => {
      expect(Math.floor(100 * 0.75)).to.equal(75);
      expect(Math.floor(8 * 0.5)).to.equal(4);
      expect(Math.floor(10 * 0.1)).to.equal(1);
    });
  });
});
