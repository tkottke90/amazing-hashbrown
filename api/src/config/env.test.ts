import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  CostEntrySchema,
  ContextWindowSchema,
  LoopGuardSchema,
  ModelConfigSchema,
  SkillsConfigSchema,
  parseFavoriteModels,
  parseProviders,
  resolveServerTimezone,
} from './env.js';

describe('config/env', () => {
  describe('SkillsConfigSchema', () => {
    it('defaults scriptTimeoutMs to 5 minutes when given an empty object', () => {
      expect(SkillsConfigSchema.parse({}).scriptTimeoutMs).to.equal(300_000);
    });

    it('accepts an overridden scriptTimeoutMs', () => {
      expect(SkillsConfigSchema.parse({ scriptTimeoutMs: 60_000 }).scriptTimeoutMs).to.equal(
        60_000,
      );
    });

    it('rejects a non-positive scriptTimeoutMs', () => {
      expect(() => SkillsConfigSchema.parse({ scriptTimeoutMs: 0 })).to.throw();
      expect(() => SkillsConfigSchema.parse({ scriptTimeoutMs: -1 })).to.throw();
    });
  });

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

  describe('ModelConfigSchema', () => {
    it('accepts id plus all pricing and sampling fields [unit]', () => {
      const input = {
        id: 'gpt-oss:20b',
        inputPricePerM: 0,
        outputPricePerM: 0,
        temperature: 1,
        topP: 0.9,
        seed: 42,
        numCtx: 16384,
        topK: 40,
        repeatPenalty: 1.1,
      };
      expect(ModelConfigSchema.parse(input)).to.deep.equal(input);
    });

    it('accepts just an id, every other field optional [unit]', () => {
      expect(ModelConfigSchema.parse({ id: 'llama3.3:70b' })).to.deep.equal({
        id: 'llama3.3:70b',
      });
    });

    it('rejects a non-numeric temperature [unit]', () => {
      expect(() => ModelConfigSchema.parse({ id: 'x', temperature: 'hot' })).to.throw();
    });

    it('rejects a non-integer seed [unit]', () => {
      expect(() => ModelConfigSchema.parse({ id: 'x', seed: 1.5 })).to.throw();
    });

    it('rejects a non-positive numCtx [unit]', () => {
      expect(() => ModelConfigSchema.parse({ id: 'x', numCtx: 0 })).to.throw();
      expect(() => ModelConfigSchema.parse({ id: 'x', numCtx: -1 })).to.throw();
    });
  });

  describe('parseProviders', () => {
    it('preserves a well-formed providers list unchanged [unit]', () => {
      const raw = [
        { name: 'local', type: 'ollama', baseUrl: 'http://localhost:11434' },
        {
          name: 'anthropic',
          type: 'anthropic',
          models: [{ id: 'claude-sonnet-4-6', inputPricePerM: 3, outputPricePerM: 15 }],
        },
      ];
      expect(parseProviders(raw)).to.deep.equal(raw);
    });

    it('drops only the malformed model entry, keeping the provider and its other models [unit]', () => {
      const raw = [
        {
          name: 'local',
          type: 'ollama',
          models: [
            { id: 'gpt-oss:20b', temperature: 'hot' },
            { id: 'llama3.3:70b', temperature: 1 },
          ],
        },
      ];
      expect(parseProviders(raw)).to.deep.equal([
        {
          name: 'local',
          type: 'ollama',
          models: [{ id: 'llama3.3:70b', temperature: 1 }],
        },
      ]);
    });

    it('drops only the malformed provider, keeping the rest of the list [unit]', () => {
      const raw = [
        { name: 'local', type: 'not-a-real-type' },
        { name: 'anthropic', type: 'anthropic' },
      ];
      expect(parseProviders(raw)).to.deep.equal([{ name: 'anthropic', type: 'anthropic' }]);
    });

    it('returns an empty list when the config value is not an array [unit]', () => {
      expect(parseProviders(undefined)).to.deep.equal([]);
      expect(parseProviders({ name: 'local' })).to.deep.equal([]);
    });

    it('preserves a well-formed azure-openai provider unchanged [unit]', () => {
      const raw = [
        {
          name: 'azure',
          type: 'azure-openai',
          endpoint: 'https://my-resource.openai.azure.com',
          deploymentName: 'gpt-4o',
          apiVersion: '2024-10-21',
          auth: {
            tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
            clientId: 'client-id',
            clientSecret: 'client-secret',
            scope: 'https://cognitiveservices.azure.com/.default',
            grantType: 'client_credentials',
          },
        },
      ];
      expect(parseProviders(raw)).to.deep.equal(raw);
    });

    it('drops an azure-openai provider missing a required OIDC field, keeping the rest of the list [unit]', () => {
      const raw = [
        {
          name: 'azure',
          type: 'azure-openai',
          endpoint: 'https://my-resource.openai.azure.com',
          deploymentName: 'gpt-4o',
          apiVersion: '2024-10-21',
          auth: { clientId: 'client-id', clientSecret: 'client-secret' }, // missing tokenUrl
        },
        { name: 'anthropic', type: 'anthropic' },
      ];
      expect(parseProviders(raw)).to.deep.equal([{ name: 'anthropic', type: 'anthropic' }]);
    });

    it('drops only the malformed model entry under an azure-openai provider, keeping its other models [unit]', () => {
      const raw = [
        {
          name: 'azure',
          type: 'azure-openai',
          endpoint: 'https://my-resource.openai.azure.com',
          deploymentName: 'gpt-4o',
          apiVersion: '2024-10-21',
          auth: { tokenUrl: 'https://login.example.com/token', clientId: 'id' },
          models: [
            { id: 'gpt-4o', temperature: 'hot' },
            { id: 'gpt-4o', temperature: 1 },
          ],
        },
      ];
      expect(parseProviders(raw)).to.deep.equal([
        {
          name: 'azure',
          type: 'azure-openai',
          endpoint: 'https://my-resource.openai.azure.com',
          deploymentName: 'gpt-4o',
          apiVersion: '2024-10-21',
          auth: {
            tokenUrl: 'https://login.example.com/token',
            clientId: 'id',
            grantType: 'client_credentials',
          },
          models: [{ id: 'gpt-4o', temperature: 1 }],
        },
      ]);
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
