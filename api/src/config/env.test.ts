import { describe, it } from 'mocha';
import { expect } from 'chai';
import { CostEntrySchema } from './env.js';

describe('config/env', () => {
  describe('CostEntrySchema', () => {
    it('defaults all fields when given an empty object', () => {
      const result = CostEntrySchema.parse({});
      expect(result).to.deep.equal({
        inputPer1kTokens: 0,
        inputScale: '1k',
        outputPer1kTokens: 0,
        outputScale: '1k',
      });
    });

    it('round-trips a fully specified 1M-scale entry unchanged', () => {
      const input = {
        inputPer1kTokens: 0.0014,
        inputScale: '1M' as const,
        outputPer1kTokens: 0.0044,
        outputScale: '1M' as const,
      };
      expect(CostEntrySchema.parse(input)).to.deep.equal(input);
    });

    it('rejects an invalid scale value', () => {
      expect(() => CostEntrySchema.parse({ inputScale: 'invalid' })).to.throw();
    });
  });
});
