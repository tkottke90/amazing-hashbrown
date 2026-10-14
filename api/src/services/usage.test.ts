import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { configManager } from '../config/env.js';
import { bootUsage, getUsageStore, seedProviderCosts } from './usage.js';

const PROVIDER = 'usage-test-provider';

describe('services/usage', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-test-'));
    db = openDatabase(join(dir, 'test.db'));
    bootUsage(db);
  });

  afterEach(() => {
    configManager.set('providers', []);
    configManager.set('costs', {});
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('seedProviderCosts', () => {
    it('reads pricing from providers[].models[], not the legacy costs map [unit]', () => {
      configManager.set('providers', [
        {
          name: PROVIDER,
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
          models: [{ id: 'model-a', inputPricePerM: 3, outputPricePerM: 15 }],
        },
      ]);
      // A legacy costs entry naming a different model — proves pricing comes
      // from providers[].models[] alone, not a merge of both sources.
      configManager.set('costs', {
        [`${PROVIDER}/legacy-model`]: {
          inputPer1kTokens: 99,
          inputScale: '1k',
          outputPer1kTokens: 99,
          outputScale: '1k',
        },
      });

      seedProviderCosts();

      const active = getUsageStore().getActiveCosts();
      expect(active).to.have.length(1);
      expect(active[0]).to.include({ providerName: PROVIDER, model: 'model-a' });
    });

    it("converts per-million prices to the store's per-1,000-token unit [unit]", () => {
      configManager.set('providers', [
        {
          name: PROVIDER,
          type: 'ollama',
          models: [{ id: 'model-a', inputPricePerM: 3, outputPricePerM: 15 }],
        },
      ]);

      seedProviderCosts();

      const [record] = getUsageStore().getActiveCosts();
      expect(record?.inputPer1kTokens).to.be.closeTo(0.003, 1e-9);
      expect(record?.outputPer1kTokens).to.be.closeTo(0.015, 1e-9);
    });

    it('skips a model with neither price field set, inserting no record [unit]', () => {
      configManager.set('providers', [
        {
          name: PROVIDER,
          type: 'ollama',
          models: [{ id: 'model-a', temperature: 1 }],
        },
      ]);

      seedProviderCosts();

      expect(getUsageStore().getActiveCosts()).to.have.length(0);
    });

    it('still seeds a model with only one price field set [unit]', () => {
      configManager.set('providers', [
        { name: PROVIDER, type: 'ollama', models: [{ id: 'model-a', inputPricePerM: 3 }] },
      ]);

      seedProviderCosts();

      const [record] = getUsageStore().getActiveCosts();
      expect(record?.inputPer1kTokens).to.be.closeTo(0.003, 1e-9);
      expect(record?.outputPer1kTokens).to.equal(0);
    });

    it('closes the old record and inserts a new one when a price changes [unit]', () => {
      configManager.set('providers', [
        { name: PROVIDER, type: 'ollama', models: [{ id: 'model-a', inputPricePerM: 3 }] },
      ]);
      seedProviderCosts();
      const firstActive = getUsageStore().getActiveCosts();
      expect(firstActive).to.have.length(1);

      configManager.set('providers', [
        { name: PROVIDER, type: 'ollama', models: [{ id: 'model-a', inputPricePerM: 6 }] },
      ]);
      seedProviderCosts();

      const active = getUsageStore().getActiveCosts();
      expect(active).to.have.length(1);
      expect(active[0]?.inputPer1kTokens).to.be.closeTo(0.006, 1e-9);
    });

    it('is a no-op on the second call when nothing changed [unit]', () => {
      configManager.set('providers', [
        { name: PROVIDER, type: 'ollama', models: [{ id: 'model-a', inputPricePerM: 3 }] },
      ]);
      seedProviderCosts();
      const firstId = getUsageStore().getActiveCosts()[0]?.id;

      seedProviderCosts();

      const active = getUsageStore().getActiveCosts();
      expect(active).to.have.length(1);
      expect(active[0]?.id).to.equal(firstId);
    });

    it('closes a record whose provider/model no longer has pricing configured [unit]', () => {
      configManager.set('providers', [
        { name: PROVIDER, type: 'ollama', models: [{ id: 'model-a', inputPricePerM: 3 }] },
      ]);
      seedProviderCosts();
      expect(getUsageStore().getActiveCosts()).to.have.length(1);

      configManager.set('providers', [{ name: PROVIDER, type: 'ollama', models: [] }]);
      seedProviderCosts();

      expect(getUsageStore().getActiveCosts()).to.have.length(0);
    });

    it('does not throw when a legacy costs entry is present [unit]', () => {
      configManager.set('costs', {
        [`${PROVIDER}/legacy-model`]: {
          inputPer1kTokens: 1,
          inputScale: '1k',
          outputPer1kTokens: 1,
          outputScale: '1k',
        },
      });
      expect(() => seedProviderCosts()).to.not.throw();
    });
  });
});
