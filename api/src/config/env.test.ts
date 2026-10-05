import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  CostEntrySchema,
  ContextWindowSchema,
  LoopGuardSchema,
  parseFavoriteModels,
  resolveServerTimezone,
} from './env.js';

describe('config/env', () => {
  describe('LoopGuardSchema', () => {
    it('defaults all fields when given an empty object', () => {
      const result = LoopGuardSchema.parse({});
      expect(result).to.deep.equal({
        enabled: true,
        stagnationNudgeThreshold: 3,
        stagnationReflectionThreshold: 5,
        streakReflectionThreshold: 10,
      });
    });

    it('rejects when stagnationReflectionThreshold does not exceed stagnationNudgeThreshold', () => {
      expect(() =>
        LoopGuardSchema.parse({
          stagnationNudgeThreshold: 5,
          stagnationReflectionThreshold: 5,
        }),
      ).to.throw();
      expect(() =>
        LoopGuardSchema.parse({
          stagnationNudgeThreshold: 5,
          stagnationReflectionThreshold: 3,
        }),
      ).to.throw();
    });

    it('round-trips enabled: false', () => {
      const result = LoopGuardSchema.parse({ enabled: false });
      expect(result.enabled).to.equal(false);
    });
  });

  describe('ContextWindowSchema', () => {
    it('defaults all fields when given an empty object', () => {
      const result = ContextWindowSchema.parse({});
      expect(result).to.deep.equal({
        enabled: true,
        maxTokens: 32000,
        safetyMarginPct: 0.85,
      });
    });
  });

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

  describe('parseFavoriteModels', () => {
    it('preserves a valid list in the user-chosen order [unit]', () => {
      const raw = [
        { provider: 'do', model: 'llama3.3-70b' },
        { provider: 'local', model: 'qwen3:14b' },
      ];
      expect(parseFavoriteModels(raw)).to.deep.equal(raw);
    });

    it('drops only the malformed entry so one hand-edit typo does not wipe every favorite [unit]', () => {
      const raw = [
        { provider: 'do', model: 'llama3.3-70b' },
        { provider: 'local' },
        'not-an-object',
        { provider: 'local', model: 'qwen3:14b' },
      ];
      expect(parseFavoriteModels(raw)).to.deep.equal([
        { provider: 'do', model: 'llama3.3-70b' },
        { provider: 'local', model: 'qwen3:14b' },
      ]);
    });

    it('rejects empty-string provider or model, which could never resolve to a real model [unit]', () => {
      expect(
        parseFavoriteModels([
          { provider: '', model: 'x' },
          { provider: 'x', model: '' },
        ]),
      ).to.deep.equal([]);
    });

    it('returns an empty list when the config value is not an array [unit]', () => {
      expect(parseFavoriteModels(undefined)).to.deep.equal([]);
      expect(parseFavoriteModels({ provider: 'do', model: 'm' })).to.deep.equal([]);
    });
  });

  describe('resolveServerTimezone', () => {
    it('passes through a valid IANA time zone unchanged [unit]', () => {
      expect(resolveServerTimezone('America/Chicago')).to.equal('America/Chicago');
    });

    it('falls back to UTC for a string that is not a valid IANA time zone [unit]', () => {
      expect(resolveServerTimezone('Not/AZone')).to.equal('UTC');
    });

    it('falls back to UTC when the configured value is missing or not a string [unit]', () => {
      expect(resolveServerTimezone(undefined)).to.equal('UTC');
      expect(resolveServerTimezone(null)).to.equal('UTC');
      expect(resolveServerTimezone(42)).to.equal('UTC');
    });
  });
});
