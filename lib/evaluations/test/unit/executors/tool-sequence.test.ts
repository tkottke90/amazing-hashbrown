import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { runToolSequence } from '../../../src/executors/tool-sequence.js';
import type { ToolSequenceScenario } from '../../../src/schemas.js';

function makeScenario(
  tool: string,
  argChecks?: ToolSequenceScenario['argChecks'],
  minScore = 1,
): ToolSequenceScenario {
  return {
    id: 'x',
    name: 'x',
    purpose: 'x',
    input: 'x',
    type: 'tool-sequence',
    priorTurns: [{ tool: 'generate_image', args: { prompt: 'x' }, result: { imageBase64: 'abc' } }],
    tool,
    argChecks,
    minScore,
  };
}

describe('runToolSequence', () => {
  describe('tool matching', () => {
    it('reports toolCalled: null and score 0 when the expected tool was not called', () => {
      const result = runToolSequence(makeScenario('upload_image'), [
        { name: 'ask_user', args: {} },
      ]);
      assert.equal(result.toolCalled, null);
      assert.equal(result.score, 0);
    });

    it('reports toolCalled: null and score 0 when no tools were called at all', () => {
      const result = runToolSequence(makeScenario('upload_image'), []);
      assert.equal(result.toolCalled, null);
      assert.equal(result.score, 0);
    });

    it('matches the tool by name among multiple calls', () => {
      const result = runToolSequence(makeScenario('upload_image'), [
        { name: 'ask_user', args: {} },
        { name: 'upload_image', args: { imageBase64: 'abc' } },
      ]);
      assert.equal(result.toolCalled, 'upload_image');
    });
  });

  describe('scoring without argChecks', () => {
    it('scores 1 when the tool matched and no argChecks were given', () => {
      const result = runToolSequence(makeScenario('upload_image'), [
        { name: 'upload_image', args: {} },
      ]);
      assert.equal(result.score, 1);
      assert.deepEqual(result.fieldResults, []);
    });
  });

  describe('scoring with argChecks', () => {
    it('scores the fraction of argChecks that passed', () => {
      const result = runToolSequence(
        makeScenario('upload_image', [
          { path: 'imageBase64', match: 'equals', value: 'abc' },
          { path: 'mimeType', match: 'exists' },
        ]),
        [{ name: 'upload_image', args: { imageBase64: 'abc' } }],
      );
      assert.equal(result.score, 0.5);
    });

    it('scores 1 when all argChecks pass', () => {
      const result = runToolSequence(
        makeScenario('upload_image', [{ path: 'imageBase64', match: 'equals', value: 'abc' }]),
        [{ name: 'upload_image', args: { imageBase64: 'abc' } }],
      );
      assert.equal(result.score, 1);
    });

    it('does not run argChecks against a call that never matched', () => {
      const result = runToolSequence(
        makeScenario('upload_image', [{ path: 'imageBase64', match: 'exists' }]),
        [{ name: 'ask_user', args: {} }],
      );
      assert.deepEqual(result.fieldResults, []);
    });
  });

  describe('matcher parity with tool-call/structured', () => {
    it('equals: passes when the arg equals the seeded value relayed exactly', () => {
      const result = runToolSequence(
        makeScenario('upload_image', [
          { path: 'imageBase64', match: 'equals', value: 'ZmFrZS1kcmFnb24tYnl0ZXM=' },
        ]),
        [{ name: 'upload_image', args: { imageBase64: 'ZmFrZS1kcmFnb24tYnl0ZXM=' } }],
      );
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('oneOf: passes when the arg value is a member of the allowed set', () => {
      const result = runToolSequence(
        makeScenario('t', [{ path: 'kind', match: 'oneOf', value: ['a', 'b'] }]),
        [{ name: 't', args: { kind: 'b' } }],
      );
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('resolves a dot-path into a nested arg object', () => {
      const result = runToolSequence(
        makeScenario('t', [{ path: 'options.nsfw', match: 'equals', value: true }]),
        [{ name: 't', args: { options: { nsfw: true } } }],
      );
      assert.equal(result.fieldResults[0].passed, true);
    });
  });
});
