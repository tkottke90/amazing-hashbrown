import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { runDeterministic } from '../../../src/executors/deterministic.js';
import type { DeterministicScenario } from '../../../src/schemas.js';

function makeScenario(match: 'contains' | 'exact' | 'regex', expected: string): DeterministicScenario {
  return { id: 'x', name: 'x', purpose: 'x', input: 'x', type: 'deterministic', match, expected };
}

describe('runDeterministic', () => {
  describe('contains', () => {
    it('passes when output includes expected', () => {
      const result = runDeterministic(makeScenario('contains', 'hello'), 'say hello world');
      assert.equal(result.passed, true);
    });

    it('fails when output does not include expected', () => {
      const result = runDeterministic(makeScenario('contains', 'goodbye'), 'say hello world');
      assert.equal(result.passed, false);
    });

    it('is case-sensitive', () => {
      const result = runDeterministic(makeScenario('contains', 'Hello'), 'say hello world');
      assert.equal(result.passed, false);
    });
  });

  describe('exact', () => {
    it('passes when trimmed output matches expected', () => {
      const result = runDeterministic(makeScenario('exact', 'hello'), '  hello  ');
      assert.equal(result.passed, true);
    });

    it('fails when output has extra content', () => {
      const result = runDeterministic(makeScenario('exact', 'hello'), 'hello world');
      assert.equal(result.passed, false);
    });

    it('is case-sensitive', () => {
      const result = runDeterministic(makeScenario('exact', 'Hello'), 'hello');
      assert.equal(result.passed, false);
    });
  });

  describe('regex', () => {
    it('passes when output matches regex', () => {
      const result = runDeterministic(makeScenario('regex', 'hel+o'), 'say hello world');
      assert.equal(result.passed, true);
    });

    it('fails when output does not match regex', () => {
      const result = runDeterministic(makeScenario('regex', '^hello$'), 'say hello world');
      assert.equal(result.passed, false);
    });

    it('works with word boundary anchors', () => {
      const result = runDeterministic(makeScenario('regex', '\\bprovider\\b'), 'configure a provider here');
      assert.equal(result.passed, true);
    });
  });

  describe('result shape', () => {
    it('returns correct type field', () => {
      const result = runDeterministic(makeScenario('contains', 'x'), 'x');
      assert.equal(result.type, 'deterministic');
    });

    it('echoes match and expected in result', () => {
      const result = runDeterministic(makeScenario('exact', 'expected value'), 'expected value');
      assert.equal(result.match, 'exact');
      assert.equal(result.expected, 'expected value');
    });
  });
});
