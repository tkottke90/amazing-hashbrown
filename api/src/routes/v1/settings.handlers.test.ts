import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import yaml from 'yaml';
import {
  reloadSettingsHandler,
  getSettingsSectionHandler,
  patchSettingsSectionHandler,
  type EnvAccessor,
  type ConfigManagerAccessor,
} from './settings.handlers.js';

// ---- Test helpers -----------------------------------------------------------

function makeEnv(overrides: Partial<EnvAccessor> = {}): EnvAccessor {
  return {
    port: 3000,
    logLevel: 'info',
    providers: [],
    defaultProvider: '',
    database: { path: 'app.db' },
    observability: { enabled: true, spanOutputPreviewChars: 500 },
    afterAgent: { enabled: true },
    chat: { showErrorMessages: false },
    embeddings: {
      enabled: true,
      type: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
    },
    webFetch: { timeoutMs: 10000, respectRobotsTxt: true },
    rlm: { maxIterations: 10, truncateThreshold: 6000, provider: undefined, model: undefined },
    costs: {},
    tools: undefined,
    ...overrides,
  };
}

function makeConfig(
  configDir: string,
  overrides: Partial<ConfigManagerAccessor> = {},
): ConfigManagerAccessor {
  return {
    get: (key: string, defaultValue?: unknown) => {
      const raw = readYaml(configDir);
      return key in raw ? raw[key] : defaultValue;
    },
    getNumber: (key: string, defaultValue: number) => {
      const raw = readYaml(configDir);
      const v = raw[key];
      return typeof v === 'number' ? v : defaultValue;
    },
    getSection: (key: string) => {
      const raw = readYaml(configDir);
      return raw[key];
    },
    getConfigDir: () => configDir,
    reload: () => {},
    ...overrides,
  };
}

function readYaml(configDir: string): Record<string, unknown> {
  const p = path.join(configDir, 'config.yaml');
  if (!fs.existsSync(p)) return {};
  return (yaml.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>) ?? {};
}

function writeYaml(configDir: string, data: Record<string, unknown>): void {
  fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.stringify(data), 'utf8');
}

function noop() {}
async function asyncNoop() {}

// ---- Suite ------------------------------------------------------------------

describe('routes/v1/settings.handlers', () => {
  // ---- reloadSettingsHandler (existing) ------------------------------------

  describe('reloadSettingsHandler()', () => {
    let calls: string[];

    beforeEach(() => {
      calls = [];
    });

    it('calls config.reload, loadAgentInstructions, invalidateChatAgent, and seedProviderCosts, in that order [orchestration]', async () => {
      await reloadSettingsHandler(
        { reload: () => calls.push('config.reload') },
        async () => {
          calls.push('loadAgentInstructions');
        },
        () => {
          calls.push('invalidateChatAgent');
        },
        () => {
          calls.push('seedProviderCosts');
        },
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
      const result = await reloadSettingsHandler({ reload: noop }, asyncNoop, noop, noop);
      expect(result).to.deep.equal({ status: 'ok' });
    });
  });

  // ---- getSettingsSectionHandler -------------------------------------------

  describe('getSettingsSectionHandler()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns 404 for unknown slug [unit]', () => {
      const result = getSettingsSectionHandler('unknown', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns { ok: true, data: {} } for mcp-servers [unit]', () => {
      const result = getSettingsSectionHandler('mcp-servers', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal({});
    });

    it('returns { ok: true, data: {} } for skills [unit]', () => {
      const result = getSettingsSectionHandler('skills', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal({});
    });

    it('returns port and logLevel for general [unit]', () => {
      writeYaml(tmpDir, { port: 4000, logLevel: 'warn' });
      const result = getSettingsSectionHandler('general', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { port: number; logLevel: string };
        expect(data.port).to.equal(4000);
        expect(data.logLevel).to.equal('warn');
      }
    });

    it('masks apiKey to "****" in model-providers GET when set [unit]', () => {
      const envWithKey = makeEnv({
        providers: [{ name: 'openai', type: 'openai', apiKey: 'sk-real-key' }],
      });
      const result = getSettingsSectionHandler('model-providers', envWithKey, makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { providers: Array<{ apiKey?: string }> };
        expect(data.providers[0].apiKey).to.equal('****');
      }
    });

    it('omits apiKey from model-providers GET when not set [unit]', () => {
      const envNoKey = makeEnv({
        providers: [{ name: 'ollama', type: 'ollama' }],
      });
      const result = getSettingsSectionHandler('model-providers', envNoKey, makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { providers: Array<{ apiKey?: string }> };
        expect(data.providers[0].apiKey).to.equal(undefined);
      }
    });

    it('masks embeddings apiKey to "****" when set [unit]', () => {
      const envWithKey = makeEnv({
        embeddings: {
          enabled: true,
          type: 'openai',
          model: 'text-embedding-3-small',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-emb-key',
        },
      });
      const result = getSettingsSectionHandler('embeddings', envWithKey, makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { apiKey?: string };
        expect(data.apiKey).to.equal('****');
      }
    });

    it('returns costs record for cost-rates [unit]', () => {
      const envWithCosts = makeEnv({
        costs: { 'gpt-4': { inputPer1kTokens: 0.03, outputPer1kTokens: 0.06 } },
      });
      const result = getSettingsSectionHandler('cost-rates', envWithCosts, makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { costs: Record<string, unknown> };
        expect(data.costs['gpt-4']).to.deep.equal({
          inputPer1kTokens: 0.03,
          outputPer1kTokens: 0.06,
        });
      }
    });
  });

  // ---- patchSettingsSectionHandler -----------------------------------------

  describe('patchSettingsSectionHandler()', () => {
    let tmpDir: string;
    let calls: string[];

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
      calls = [];
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeSideEffects() {
      return {
        loadAgentInstructions: async () => {
          calls.push('loadAgentInstructions');
        },
        invalidateChatAgent: () => {
          calls.push('invalidateChatAgent');
        },
        seedProviderCosts: () => {
          calls.push('seedProviderCosts');
        },
      };
    }

    it('returns 404 for unknown slug [unit]', async () => {
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();
      const result = await patchSettingsSectionHandler(
        'unknown',
        {},
        makeConfig(tmpDir),
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 404 for mcp-servers PATCH [unit]', async () => {
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();
      const result = await patchSettingsSectionHandler(
        'mcp-servers',
        {},
        makeConfig(tmpDir),
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 404 for skills PATCH [unit]', async () => {
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();
      const result = await patchSettingsSectionHandler(
        'skills',
        {},
        makeConfig(tmpDir),
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 with fieldErrors when body fails validation [unit]', async () => {
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();
      const result = await patchSettingsSectionHandler(
        'general',
        { logLevel: 123 }, // should be string
        makeConfig(tmpDir),
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.fieldErrors).to.have.property('logLevel');
      }
    });

    it('writes logLevel to config.yaml and calls side effects on success [unit]', async () => {
      const reloaded: string[] = [];
      const config = makeConfig(tmpDir, { reload: () => reloaded.push('reload') });
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'general',
        { logLevel: 'debug' },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      expect(written.logLevel).to.equal('debug');
      expect(reloaded).to.deep.equal(['reload']);
      expect(calls).to.deep.equal([
        'loadAgentInstructions',
        'invalidateChatAgent',
        'seedProviderCosts',
      ]);
    });

    it('PATCH general returns the new GET response (includes updated logLevel) [unit]', async () => {
      // Prime the config file with the new value so makeConfig reads it back
      writeYaml(tmpDir, { logLevel: 'debug', port: 3000 });
      const config = makeConfig(tmpDir);
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'general',
        { logLevel: 'debug' },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );

      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { logLevel: string };
        expect(data.logLevel).to.equal('debug');
      }
    });

    it('preserves stored apiKey when incoming is "****" for model-providers [unit]', async () => {
      const storedProviders: EnvAccessor['providers'] = [
        { name: 'openai', type: 'openai', apiKey: 'sk-real-stored-key' },
      ];
      const envWithKey = makeEnv({ providers: storedProviders });
      const config = makeConfig(tmpDir);
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();

      await patchSettingsSectionHandler(
        'model-providers',
        { providers: [{ name: 'openai', type: 'openai', apiKey: '****' }] },
        config,
        envWithKey,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );

      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ apiKey?: string }>;
      expect(savedProviders[0].apiKey).to.equal('sk-real-stored-key');
    });

    it('replaces apiKey when incoming is a new plaintext value for model-providers [unit]', async () => {
      const storedProviders: EnvAccessor['providers'] = [
        { name: 'openai', type: 'openai', apiKey: 'sk-old-key' },
      ];
      const envWithKey = makeEnv({ providers: storedProviders });
      const config = makeConfig(tmpDir);
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();

      await patchSettingsSectionHandler(
        'model-providers',
        { providers: [{ name: 'openai', type: 'openai', apiKey: 'sk-new-key' }] },
        config,
        envWithKey,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );

      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ apiKey?: string }>;
      expect(savedProviders[0].apiKey).to.equal('sk-new-key');
    });

    it('clears apiKey when incoming is empty string for model-providers [unit]', async () => {
      const storedProviders: EnvAccessor['providers'] = [
        { name: 'openai', type: 'openai', apiKey: 'sk-old-key' },
      ];
      const envWithKey = makeEnv({ providers: storedProviders });
      const config = makeConfig(tmpDir);
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();

      await patchSettingsSectionHandler(
        'model-providers',
        { providers: [{ name: 'openai', type: 'openai', apiKey: '' }] },
        config,
        envWithKey,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );

      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ apiKey?: string }>;
      expect(savedProviders[0].apiKey).to.equal('');
    });

    it('writes cost-rates and returns updated costs [unit]', async () => {
      const config = makeConfig(tmpDir);
      const envEmpty = makeEnv({ costs: {} });
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'cost-rates',
        { costs: { 'gpt-4': { inputPer1kTokens: 0.03, outputPer1kTokens: 0.06 } } },
        config,
        envEmpty,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      expect((written.costs as Record<string, unknown>)['gpt-4']).to.deep.equal({
        inputPer1kTokens: 0.03,
        outputPer1kTokens: 0.06,
      });
    });

    it('does not call side effects when PATCH fails validation [unit]', async () => {
      const { loadAgentInstructions, invalidateChatAgent, seedProviderCosts } = makeSideEffects();
      await patchSettingsSectionHandler(
        'general',
        { logLevel: 99 },
        makeConfig(tmpDir),
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
      );
      expect(calls).to.deep.equal([]);
    });
  });
});
