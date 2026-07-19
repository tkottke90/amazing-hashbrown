import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { runToolCall } from '../../../src/executors/tool-call.js';
import type { ToolCallScenario } from '../../../src/schemas.js';

function makeScenario(
  tool: string,
  argChecks?: ToolCallScenario['argChecks'],
  minScore = 1,
): ToolCallScenario {
  return {
    id: 'x',
    name: 'x',
    purpose: 'x',
    input: 'x',
    type: 'tool-call',
    tool,
    argChecks,
    minScore,
  };
}

describe('runToolCall', () => {
  describe('tool matching', () => {
    it('reports toolCalled: null and score 0 when the expected tool was not called', () => {
      const result = runToolCall(makeScenario('upload_image'), [
        { name: 'ask_user', args: {} },
      ]);
      assert.equal(result.toolCalled, null);
      assert.equal(result.score, 0);
    });

    it('reports toolCalled: null and score 0 when no tools were called at all', () => {
      const result = runToolCall(makeScenario('upload_image'), []);
      assert.equal(result.toolCalled, null);
      assert.equal(result.score, 0);
    });

    it('matches the tool by name among multiple calls', () => {
      const result = runToolCall(makeScenario('upload_image'), [
        { name: 'ask_user', args: {} },
        { name: 'upload_image', args: { mimeType: 'image/png' } },
      ]);
      assert.equal(result.toolCalled, 'upload_image');
    });
  });

  describe('scoring without argChecks', () => {
    it('scores 1 when the tool matched and no argChecks were given', () => {
      const result = runToolCall(makeScenario('upload_image'), [
        { name: 'upload_image', args: {} },
      ]);
      assert.equal(result.score, 1);
      assert.deepEqual(result.fieldResults, []);
    });
  });

  describe('scoring with argChecks', () => {
    it('scores the fraction of argChecks that passed', () => {
      const result = runToolCall(
        makeScenario('upload_image', [
          { path: 'mimeType', match: 'exists' },
          { path: 'nsfw', match: 'equals', value: true },
        ]),
        [{ name: 'upload_image', args: { mimeType: 'image/png', nsfw: false } }],
      );
      assert.equal(result.score, 0.5);
    });

    it('scores 1 when all argChecks pass', () => {
      const result = runToolCall(
        makeScenario('upload_image', [{ path: 'mimeType', match: 'exists' }]),
        [{ name: 'upload_image', args: { mimeType: 'image/png' } }],
      );
      assert.equal(result.score, 1);
    });

    it('does not run argChecks against a call that never matched', () => {
      const result = runToolCall(
        makeScenario('upload_image', [{ path: 'mimeType', match: 'exists' }]),
        [{ name: 'ask_user', args: {} }],
      );
      assert.deepEqual(result.fieldResults, []);
    });
  });

  describe('matcher parity with structured', () => {
    it('equals: passes when the arg equals the expected value', () => {
      const result = runToolCall(
        makeScenario('t', [{ path: 'nsfw', match: 'equals', value: true }]),
        [{ name: 't', args: { nsfw: true } }],
      );
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('contains: passes when a string arg contains the expected substring', () => {
      const result = runToolCall(
        makeScenario('t', [{ path: 'alt', match: 'contains', value: 'cat' }]),
        [{ name: 't', args: { alt: 'a photo of a cat' } }],
      );
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('oneOf: passes when the arg value is a member of the allowed set', () => {
      const result = runToolCall(
        makeScenario('t', [{ path: 'kind', match: 'oneOf', value: ['a', 'b'] }]),
        [{ name: 't', args: { kind: 'b' } }],
      );
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('resolves a dot-path into a nested arg object', () => {
      const result = runToolCall(
        makeScenario('t', [{ path: 'options.nsfw', match: 'equals', value: true }]),
        [{ name: 't', args: { options: { nsfw: true } } }],
      );
      assert.equal(result.fieldResults[0].passed, true);
    });
  });
});
