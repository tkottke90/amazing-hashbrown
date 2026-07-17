import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { runStructured } from '../../../src/executors/structured.js';
import type { StructuredScenario } from '../../../src/schemas.js';

function makeScenario(
  fieldChecks: StructuredScenario['fieldChecks'],
  minScore = 1,
): StructuredScenario {
  return {
    id: 'x',
    name: 'x',
    purpose: 'x',
    input: 'x',
    type: 'structured',
    outputSchema: {},
    fieldChecks,
    minScore,
  };
}

describe('runStructured', () => {
  describe('equals', () => {
    it('passes when the field equals the expected value', () => {
      const result = runStructured(
        makeScenario([{ path: 'shouldWrite', match: 'equals', value: true }]),
        { shouldWrite: true },
      );
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('fails when the field does not equal the expected value', () => {
      const result = runStructured(
        makeScenario([{ path: 'shouldWrite', match: 'equals', value: true }]),
        { shouldWrite: false },
      );
      assert.equal(result.fieldResults[0].passed, false);
    });
  });

  describe('exists', () => {
    it('passes when the field is present and non-null', () => {
      const result = runStructured(makeScenario([{ path: 'title', match: 'exists' }]), {
        title: 'Acme Corp',
      });
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('fails when the field is undefined', () => {
      const result = runStructured(makeScenario([{ path: 'title', match: 'exists' }]), {});
      assert.equal(result.fieldResults[0].passed, false);
    });

    it('fails when the field is null', () => {
      const result = runStructured(makeScenario([{ path: 'title', match: 'exists' }]), {
        title: null,
      });
      assert.equal(result.fieldResults[0].passed, false);
    });
  });

  describe('contains', () => {
    it('passes when a string field contains the expected substring', () => {
      const result = runStructured(
        makeScenario([{ path: 'reason', match: 'contains', value: 'novel' }]),
        { reason: 'this is novel information' },
      );
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('passes when an array field contains the expected element', () => {
      const result = runStructured(
        makeScenario([{ path: 'tags', match: 'contains', value: 'rust' }]),
        { tags: ['rust', 'backend'] },
      );
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('fails when the array field does not contain the expected element', () => {
      const result = runStructured(
        makeScenario([{ path: 'tags', match: 'contains', value: 'rust' }]),
        { tags: ['python'] },
      );
      assert.equal(result.fieldResults[0].passed, false);
    });
  });

  describe('oneOf', () => {
    it('passes when the field value is a member of the allowed set', () => {
      const result = runStructured(
        makeScenario([{ path: 'type', match: 'oneOf', value: ['entity', 'concept'] }]),
        { type: 'concept' },
      );
      assert.equal(result.fieldResults[0].passed, true);
    });

    it('fails when the field value is not a member of the allowed set', () => {
      const result = runStructured(
        makeScenario([{ path: 'type', match: 'oneOf', value: ['entity', 'concept'] }]),
        { type: 'log' },
      );
      assert.equal(result.fieldResults[0].passed, false);
    });
  });

  describe('scoring', () => {
    it('scores the fraction of checks that passed', () => {
      const result = runStructured(
        makeScenario([
          { path: 'a', match: 'equals', value: true },
          { path: 'b', match: 'equals', value: true },
        ]),
        { a: true, b: false },
      );
      assert.equal(result.score, 0.5);
    });

    it('scores 1 when all checks pass', () => {
      const result = runStructured(makeScenario([{ path: 'a', match: 'equals', value: true }]), {
        a: true,
      });
      assert.equal(result.score, 1);
    });
  });

  describe('nested paths', () => {
    it('resolves a dot-path into a nested object', () => {
      const result = runStructured(
        makeScenario([{ path: 'details.domainId', match: 'equals', value: 'user' }]),
        { details: { domainId: 'user' } },
      );
      assert.equal(result.fieldResults[0].passed, true);
    });
  });
});
