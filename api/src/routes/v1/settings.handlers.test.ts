import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import yaml from 'yaml';
import {
  reloadSettingsHandler,
  getSettingsSectionHandler,
  patchSettingsSectionHandler,
  validateFavoriteModels,
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
    favoriteModels: [],
    database: { path: 'app.db' },
    observability: { enabled: true, spanOutputPreviewChars: 500 },
    afterAgent: { enabled: true },
    updates: { checkForUpdates: false },
    chat: { showErrorMessages: false, codeBlockWrap: false },
    taskBoard: { doneRetentionDays: 5 },
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
    workspaces: {},
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

// Local stand-in for an azure-openai provider's OIDC token endpoint — same
// "a real HTTP call is the only way to exercise this" rationale as
// provider-factory.test.ts's startModelsServer, since the model-providers
// write path's Rotate check calls the real AzureTokenCache.refresh().
function startTokenServer(
  status: number,
  body: unknown,
): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

// ---- Suite ------------------------------------------------------------------

describe('routes/v1/settings.handlers', () => {
  // ---- reloadSettingsHandler (existing) ------------------------------------

  describe('reloadSettingsHandler()', () => {
    let calls: string[];

    beforeEach(() => {
      calls = [];
    });

    it('calls config.reload, loadAgentInstructions, invalidateChatAgent, seedProviderCosts, and reloadTrackerRegistry, in that order [orchestration]', async () => {
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
        () => {
          calls.push('reloadTrackerRegistry');
        },
      );

      expect(calls).to.deep.equal([
        'config.reload',
        'loadAgentInstructions',
        'invalidateChatAgent',
        'seedProviderCosts',
        'reloadTrackerRegistry',
      ]);
    });

    it('calls each dependency exactly once [orchestration]', async () => {
      const counts = { reload: 0, load: 0, invalidate: 0, seed: 0, reloadTrackers: 0 };
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
        () => {
          counts.reloadTrackers++;
        },
      );
      expect(counts).to.deep.equal({
        reload: 1,
        load: 1,
        invalidate: 1,
        seed: 1,
        reloadTrackers: 1,
      });
    });

    it('resolves with { status: "ok" } [unit]', async () => {
      const result = await reloadSettingsHandler({ reload: noop }, asyncNoop, noop, noop, noop);
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

    it('returns chat.codeBlockWrap defaulting to false for agent-behavior [unit]', () => {
      const result = getSettingsSectionHandler('agent-behavior', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { chat: { codeBlockWrap: boolean } };
        expect(data.chat.codeBlockWrap).to.equal(false);
      }
    });

    it('returns taskBoard.doneRetentionDays defaulting to 5 for agent-behavior (ADR-0031) [unit]', () => {
      const result = getSettingsSectionHandler('agent-behavior', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { taskBoard: { doneRetentionDays: number } };
        expect(data.taskBoard.doneRetentionDays).to.equal(5);
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

    it('masks auth.clientSecret (not apiKey) to "****" in model-providers GET for an azure-openai provider [unit]', () => {
      const envWithAzure = makeEnv({
        providers: [
          {
            name: 'azure',
            type: 'azure-openai',
            endpoint: 'https://my-resource.openai.azure.com',
            deploymentName: 'gpt-4o',
            apiVersion: '2024-10-21',
            auth: {
              tokenUrl: 'https://login.example.com/token',
              clientId: 'client-id',
              clientSecret: 'real-secret',
              grantType: 'client_credentials',
            },
          },
        ],
      });
      const result = getSettingsSectionHandler('model-providers', envWithAzure, makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as {
          providers: Array<{ apiKey?: string; auth?: { clientId: string; clientSecret?: string } }>;
        };
        expect(data.providers[0].apiKey).to.equal(undefined);
        expect(data.providers[0].auth?.clientId).to.equal('client-id');
        expect(data.providers[0].auth?.clientSecret).to.equal('****');
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

    it('masks trackers github token to "****" when set [unit]', () => {
      // The stored token must be seeded into actual config.yaml (not via
      // makeEnv) — get() reads the raw file directly (issue #220: building
      // a secret's display from the resolved env.* getter would leak a
      // resolved ${VAR} reference's real value).
      writeYaml(tmpDir, {
        workspaces: { tasks: { trackers: { github: { token: 'ghp_real_token' } } } },
      });
      const result = getSettingsSectionHandler('trackers', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { github: { token?: string } };
        expect(data.github.token).to.equal('****');
      }
    });

    it('shows trackers github token as its ${VAR} reference, not masked, when stored as an env lookup [unit]', () => {
      writeYaml(tmpDir, {
        workspaces: { tasks: { trackers: { github: { token: '${GH_TOKEN}' } } } },
      });
      const result = getSettingsSectionHandler('trackers', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { github: { token?: string } };
        expect(data.github.token).to.equal('${GH_TOKEN}');
      }
    });

    it('omits trackers github token from GET when not set [unit]', () => {
      const result = getSettingsSectionHandler('trackers', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { github: { token?: string } };
        expect(data.github.token).to.equal(undefined);
      }
    });

    it('masks git-credentials github token to "****" when set [unit]', () => {
      writeYaml(tmpDir, { workspaces: { git: { github: { token: 'ghp_git_token' } } } });
      const result = getSettingsSectionHandler('git-credentials', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { github: { token?: string } };
        expect(data.github.token).to.equal('****');
      }
    });

    it('shows git-credentials github token as its ${VAR} reference when stored as an env lookup [unit]', () => {
      writeYaml(tmpDir, { workspaces: { git: { github: { token: '${GH_TOKEN}' } } } });
      const result = getSettingsSectionHandler('git-credentials', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { github: { token?: string } };
        expect(data.github.token).to.equal('${GH_TOKEN}');
      }
    });

    it('omits git-credentials github token from GET when not set [unit]', () => {
      const result = getSettingsSectionHandler('git-credentials', makeEnv(), makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { github: { token?: string } };
        expect(data.github.token).to.equal(undefined);
      }
    });

    // The two slugs share the `workspaces` top-level YAML key. get() must
    // never cross-contaminate: reading one slug's section shows only that
    // slug's stored value, even when the other is also set.
    it('getSettingsSectionHandler keeps trackers and git-credentials tokens independent [unit]', () => {
      writeYaml(tmpDir, {
        workspaces: {
          tasks: { trackers: { github: { token: 'ghp_tracker_token' } } },
          git: { github: { token: 'ghp_git_token' } },
        },
      });
      const trackers = getSettingsSectionHandler('trackers', makeEnv(), makeConfig(tmpDir));
      const gitCreds = getSettingsSectionHandler('git-credentials', makeEnv(), makeConfig(tmpDir));
      expect(trackers.ok && gitCreds.ok).to.equal(true);
      if (trackers.ok && gitCreds.ok) {
        expect((trackers.data as { github: { token?: string } }).github.token).to.equal('****');
        expect((gitCreds.data as { github: { token?: string } }).github.token).to.equal('****');
      }
    });

    it('returns configured models and legacy cost keys for model-settings [unit]', () => {
      const env = makeEnv({
        providers: [
          {
            name: 'openai',
            type: 'openai',
            models: [{ id: 'gpt-4', inputPricePerM: 30, outputPricePerM: 60, temperature: 0.5 }],
          },
        ],
        costs: {
          'anthropic/claude-sonnet-4-6': {
            inputPer1kTokens: 0.003,
            inputScale: '1k',
            outputPer1kTokens: 0.015,
            outputScale: '1k',
          },
        },
      });
      const result = getSettingsSectionHandler('model-settings', env, makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { models: unknown[]; legacyCosts: string[] };
        expect(data.models).to.deep.equal([
          {
            provider: 'openai',
            providerType: 'openai',
            modelId: 'gpt-4',
            inputPricePerM: 30,
            outputPricePerM: 60,
            temperature: 0.5,
            topP: undefined,
            seed: undefined,
            numCtx: undefined,
            topK: undefined,
            repeatPenalty: undefined,
          },
        ]);
        expect(data.legacyCosts).to.deep.equal(['anthropic/claude-sonnet-4-6']);
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
        reloadTrackerRegistry: () => {
          calls.push('reloadTrackerRegistry');
        },
      };
    }

    it('returns 404 for unknown slug [unit]', async () => {
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();
      const result = await patchSettingsSectionHandler(
        'unknown',
        {},
        makeConfig(tmpDir),
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 404 for skills PATCH [unit]', async () => {
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();
      const result = await patchSettingsSectionHandler(
        'skills',
        {},
        makeConfig(tmpDir),
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 with fieldErrors when body fails validation [unit]', async () => {
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();
      const result = await patchSettingsSectionHandler(
        'general',
        { logLevel: 123 }, // should be string
        makeConfig(tmpDir),
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
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
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'general',
        { logLevel: 'debug' },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      expect(written.logLevel).to.equal('debug');
      expect(reloaded).to.deep.equal(['reload']);
      expect(calls).to.deep.equal([
        'loadAgentInstructions',
        'invalidateChatAgent',
        'seedProviderCosts',
        'reloadTrackerRegistry',
      ]);
    });

    it('PATCH agent-behavior writes chat.codeBlockWrap while preserving showErrorMessages [unit]', async () => {
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'agent-behavior',
        { chat: { codeBlockWrap: true } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      // Note: unlike `general` (which reads live off disk via `config.get`),
      // `agent-behavior`'s GET reads from the `env` snapshot passed in — a
      // static object here, not a live getter like the real env.ts. So the
      // handler's immediate response below still reflects `makeEnv()`'s
      // original values; what proves the write merged correctly is the
      // persisted file.
      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      // ChatSchema.partial() doesn't strip each field's own .default() — an
      // omitted field re-applies its default rather than staying untouched.
      // showErrorMessages/codeBlockWrap's defaults happen to match
      // makeEnv()'s own values, so this was never visible before;
      // sidebarRetentionDays's non-zero default (ADR-0030) makes the same
      // pre-existing behavior show up here too.
      expect(written.chat).to.deep.equal({
        showErrorMessages: false,
        codeBlockWrap: true,
        sidebarRetentionDays: 7,
      });
    });

    it('PATCH agent-behavior rejects chat.contextWindow.maxTokens below its floor [unit]', async () => {
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'agent-behavior',
        { chat: { contextWindow: { maxTokens: 1000 } } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.status).to.equal(400);
      // zod's .flatten().fieldErrors only keys by the top-level patchSchema
      // segment — a failure nested at chat.contextWindow.maxTokens surfaces
      // as `chat`, the same single error slot the UI's chat card already
      // reads via fieldErrors.value['chat'].
      expect(result.fieldErrors?.chat).to.be.an('array').with.length.greaterThan(0);
    });

    it('PATCH agent-behavior writes chat.mcpToolStub.enabled [unit]', async () => {
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'agent-behavior',
        { chat: { mcpToolStub: { enabled: false } } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      expect(written.chat).to.deep.equal({
        showErrorMessages: false,
        codeBlockWrap: false,
        sidebarRetentionDays: 7,
        mcpToolStub: { enabled: false },
      });
    });

    it('PATCH agent-behavior writes taskBoard.doneRetentionDays [unit]', async () => {
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'agent-behavior',
        { taskBoard: { doneRetentionDays: 10 } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      expect(written.taskBoard).to.deep.equal({ doneRetentionDays: 10 });
    });

    it('PATCH general returns the new GET response (includes updated logLevel) [unit]', async () => {
      // Prime the config file with the new value so makeConfig reads it back
      writeYaml(tmpDir, { logLevel: 'debug', port: 3000 });
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'general',
        { logLevel: 'debug' },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
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
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      await patchSettingsSectionHandler(
        'model-providers',
        { providers: [{ name: 'openai', type: 'openai', apiKey: '****' }] },
        config,
        envWithKey,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
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
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      await patchSettingsSectionHandler(
        'model-providers',
        { providers: [{ name: 'openai', type: 'openai', apiKey: 'sk-new-key' }] },
        config,
        envWithKey,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ apiKey?: string }>;
      expect(savedProviders[0].apiKey).to.equal('sk-new-key');
    });

    it('preserves stored clientSecret when incoming is "****" for an azure-openai provider, with no token fetch [unit]', async () => {
      const storedProviders: EnvAccessor['providers'] = [
        {
          name: 'azure-rotate-test',
          type: 'azure-openai',
          endpoint: 'https://my-resource.openai.azure.com',
          deploymentName: 'gpt-4o',
          apiVersion: '2024-10-21',
          auth: {
            tokenUrl: 'https://unreachable.example.invalid/token',
            clientId: 'client-id',
            clientSecret: 'real-secret',
            grantType: 'client_credentials',
          },
        },
      ];
      const envWithAzure = makeEnv({ providers: storedProviders });
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      // clientId/clientSecret are both unchanged (**** resolves back to the
      // stored secret) — not a Rotate, so no token fetch should happen at
      // all, which this test proves by pointing tokenUrl at an address that
      // would reject/hang if actually contacted.
      const result = await patchSettingsSectionHandler(
        'model-providers',
        {
          providers: [
            {
              name: 'azure-rotate-test',
              type: 'azure-openai',
              endpoint: 'https://my-resource.openai.azure.com',
              deploymentName: 'gpt-4o',
              apiVersion: '2024-10-21',
              auth: {
                tokenUrl: 'https://unreachable.example.invalid/token',
                clientId: 'client-id',
                clientSecret: '****',
                grantType: 'client_credentials',
              },
            },
          ],
        },
        config,
        envWithAzure,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ auth?: { clientSecret?: string } }>;
      expect(savedProviders[0].auth?.clientSecret).to.equal('real-secret');
    });

    it("rejects the whole PATCH and writes nothing when a Rotate's new Client Credentials fail to authenticate [unit]", async () => {
      const tokenServer = await startTokenServer(401, { error: 'invalid_client' });
      try {
        const storedProviders: EnvAccessor['providers'] = [
          {
            name: 'azure-rotate-test',
            type: 'azure-openai',
            endpoint: 'https://my-resource.openai.azure.com',
            deploymentName: 'gpt-4o',
            apiVersion: '2024-10-21',
            auth: {
              tokenUrl: tokenServer.baseUrl,
              clientId: 'old-client-id',
              clientSecret: 'old-secret',
              grantType: 'client_credentials',
            },
          },
        ];
        const envWithAzure = makeEnv({ providers: storedProviders });
        const config = makeConfig(tmpDir);
        const {
          loadAgentInstructions,
          invalidateChatAgent,
          seedProviderCosts,
          reloadTrackerRegistry,
        } = makeSideEffects();

        const result = await patchSettingsSectionHandler(
          'model-providers',
          {
            providers: [
              {
                name: 'azure-rotate-test',
                type: 'azure-openai',
                endpoint: 'https://my-resource.openai.azure.com',
                deploymentName: 'gpt-4o',
                apiVersion: '2024-10-21',
                auth: {
                  tokenUrl: tokenServer.baseUrl,
                  clientId: 'new-client-id',
                  clientSecret: 'new-secret',
                  grantType: 'client_credentials',
                },
              },
            ],
          },
          config,
          envWithAzure,
          loadAgentInstructions,
          invalidateChatAgent,
          seedProviderCosts,
          reloadTrackerRegistry,
        );

        expect(result.ok).to.equal(false);
        if (!result.ok) {
          expect(result.status).to.equal(400);
          expect(result.fieldErrors?.providers?.[0]).to.match(
            /Failed to authenticate "azure-rotate-test"/,
          );
        }
        // Nothing was written — the stored (old) credentials are untouched.
        expect(readYaml(tmpDir)).to.deep.equal({});
      } finally {
        tokenServer.close();
      }
    });

    it("persists a Rotate's new Client Credentials once they authenticate successfully [unit]", async () => {
      const tokenServer = await startTokenServer(200, { access_token: 'tok-1', expires_in: 3600 });
      try {
        const storedProviders: EnvAccessor['providers'] = [
          {
            name: 'azure-rotate-test',
            type: 'azure-openai',
            endpoint: 'https://my-resource.openai.azure.com',
            deploymentName: 'gpt-4o',
            apiVersion: '2024-10-21',
            auth: {
              tokenUrl: tokenServer.baseUrl,
              clientId: 'old-client-id',
              clientSecret: 'old-secret',
              grantType: 'client_credentials',
            },
          },
        ];
        const envWithAzure = makeEnv({ providers: storedProviders });
        const config = makeConfig(tmpDir);
        const {
          loadAgentInstructions,
          invalidateChatAgent,
          seedProviderCosts,
          reloadTrackerRegistry,
        } = makeSideEffects();

        const result = await patchSettingsSectionHandler(
          'model-providers',
          {
            providers: [
              {
                name: 'azure-rotate-test',
                type: 'azure-openai',
                endpoint: 'https://my-resource.openai.azure.com',
                deploymentName: 'gpt-4o',
                apiVersion: '2024-10-21',
                auth: {
                  tokenUrl: tokenServer.baseUrl,
                  clientId: 'new-client-id',
                  clientSecret: 'new-secret',
                  grantType: 'client_credentials',
                },
              },
            ],
          },
          config,
          envWithAzure,
          loadAgentInstructions,
          invalidateChatAgent,
          seedProviderCosts,
          reloadTrackerRegistry,
        );

        expect(result.ok).to.equal(true);
        const written = readYaml(tmpDir);
        const savedProviders = written.providers as Array<{
          auth?: { clientId?: string; clientSecret?: string };
        }>;
        expect(savedProviders[0].auth?.clientId).to.equal('new-client-id');
        expect(savedProviders[0].auth?.clientSecret).to.equal('new-secret');
      } finally {
        tokenServer.close();
      }
    });

    it('writes trackers github token nested under workspaces.tasks.trackers [unit]', async () => {
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      await patchSettingsSectionHandler(
        'trackers',
        { github: { token: 'ghp_new_token' } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      const written = readYaml(tmpDir);
      const workspaces = written.workspaces as {
        tasks: { trackers: { github: { token: string } } };
      };
      expect(workspaces.tasks.trackers.github.token).to.equal('ghp_new_token');
    });

    it('preserves stored trackers github token when incoming is "****" [unit]', async () => {
      // Seeded into config.yaml directly, same reason as the GET test
      // above — write() resolves the "stored" value from the raw file.
      writeYaml(tmpDir, {
        workspaces: { tasks: { trackers: { github: { token: 'ghp_stored_token' } } } },
      });
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      await patchSettingsSectionHandler(
        'trackers',
        { github: { token: '****' } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      const written = readYaml(tmpDir);
      const workspaces = written.workspaces as {
        tasks: { trackers: { github: { token: string } } };
      };
      expect(workspaces.tasks.trackers.github.token).to.equal('ghp_stored_token');
    });

    it('preserves stored trackers github token when it is a ${VAR} reference [unit]', async () => {
      writeYaml(tmpDir, {
        workspaces: { tasks: { trackers: { github: { token: '${GH_TOKEN}' } } } },
      });
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      await patchSettingsSectionHandler(
        'trackers',
        { github: { token: '****' } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      const written = readYaml(tmpDir);
      const workspaces = written.workspaces as {
        tasks: { trackers: { github: { token: string } } };
      };
      expect(workspaces.tasks.trackers.github.token).to.equal('${GH_TOKEN}');
    });

    it('rejects a trackers github token referencing a ${VAR} that is not set [unit]', async () => {
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();
      delete process.env['SETTINGS_TEST_UNSET_VAR'];

      const result = await patchSettingsSectionHandler(
        'trackers',
        { github: { token: '${SETTINGS_TEST_UNSET_VAR}' } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.fieldErrors?.['github.token']?.[0]).to.include('SETTINGS_TEST_UNSET_VAR');
      }
    });

    it('clears trackers github token when incoming is empty string [unit]', async () => {
      writeYaml(tmpDir, {
        workspaces: { tasks: { trackers: { github: { token: 'ghp_stored_token' } } } },
      });
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      await patchSettingsSectionHandler(
        'trackers',
        { github: { token: '' } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      const written = readYaml(tmpDir);
      const workspaces = written.workspaces as {
        tasks: { trackers: { github: { token: string } } };
      };
      expect(workspaces.tasks.trackers.github.token).to.equal('');
    });

    it('writes git-credentials github token nested under workspaces.git [unit]', async () => {
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      await patchSettingsSectionHandler(
        'git-credentials',
        { github: { token: 'ghp_new_git_token' } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      const written = readYaml(tmpDir);
      const workspaces = written.workspaces as { git: { github: { token: string } } };
      expect(workspaces.git.github.token).to.equal('ghp_new_git_token');
    });

    it('preserves stored git-credentials github token when incoming is "****" [unit]', async () => {
      writeYaml(tmpDir, { workspaces: { git: { github: { token: 'ghp_stored_git_token' } } } });
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      await patchSettingsSectionHandler(
        'git-credentials',
        { github: { token: '****' } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      const written = readYaml(tmpDir);
      const workspaces = written.workspaces as { git: { github: { token: string } } };
      expect(workspaces.git.github.token).to.equal('ghp_stored_git_token');
    });

    it('rejects a git-credentials github token referencing a ${VAR} that is not set [unit]', async () => {
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();
      delete process.env['SETTINGS_TEST_UNSET_VAR'];

      const result = await patchSettingsSectionHandler(
        'git-credentials',
        { github: { token: '${SETTINGS_TEST_UNSET_VAR}' } },
        config,
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.fieldErrors?.['github.token']?.[0]).to.include('SETTINGS_TEST_UNSET_VAR');
      }
    });

    // The real-world bug this guards against: mergeConfigYaml() is a
    // shallow merge at the top-level YAML key, and both `trackers` and
    // `git-credentials` write under the same `workspaces` key. Saving
    // either one must never wipe out whatever the other already stored.
    describe('workspaces subtree is not clobbered across slugs', () => {
      async function patchSlug(slug: string, token: string, config: ConfigManagerAccessor) {
        const {
          loadAgentInstructions,
          invalidateChatAgent,
          seedProviderCosts,
          reloadTrackerRegistry,
        } = makeSideEffects();
        await patchSettingsSectionHandler(
          slug,
          { github: { token } },
          config,
          makeEnv(),
          loadAgentInstructions,
          invalidateChatAgent,
          seedProviderCosts,
          reloadTrackerRegistry,
        );
      }

      it('saving git-credentials after trackers preserves both [unit]', async () => {
        const config = makeConfig(tmpDir);
        await patchSlug('trackers', 'ghp_tracker_token', config);
        await patchSlug('git-credentials', 'ghp_git_token', config);

        const workspaces = readYaml(tmpDir).workspaces as {
          tasks: { trackers: { github: { token: string } } };
          git: { github: { token: string } };
        };
        expect(workspaces.tasks.trackers.github.token).to.equal('ghp_tracker_token');
        expect(workspaces.git.github.token).to.equal('ghp_git_token');
      });

      it('saving trackers after git-credentials preserves both [unit]', async () => {
        const config = makeConfig(tmpDir);
        await patchSlug('git-credentials', 'ghp_git_token', config);
        await patchSlug('trackers', 'ghp_tracker_token', config);

        const workspaces = readYaml(tmpDir).workspaces as {
          tasks: { trackers: { github: { token: string } } };
          git: { github: { token: string } };
        };
        expect(workspaces.tasks.trackers.github.token).to.equal('ghp_tracker_token');
        expect(workspaces.git.github.token).to.equal('ghp_git_token');
      });
    });

    it('clears apiKey when incoming is empty string for model-providers [unit]', async () => {
      const storedProviders: EnvAccessor['providers'] = [
        { name: 'openai', type: 'openai', apiKey: 'sk-old-key' },
      ];
      const envWithKey = makeEnv({ providers: storedProviders });
      const config = makeConfig(tmpDir);
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      await patchSettingsSectionHandler(
        'model-providers',
        { providers: [{ name: 'openai', type: 'openai', apiKey: '' }] },
        config,
        envWithKey,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ apiKey?: string }>;
      expect(savedProviders[0].apiKey).to.equal('');
    });

    it("writes a new model-settings entry into its provider's models[] [unit]", async () => {
      writeYaml(tmpDir, {
        providers: [{ name: 'openai', type: 'openai' }],
      });
      const config = makeConfig(tmpDir);
      const env = makeEnv({ providers: [{ name: 'openai', type: 'openai' }] });
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'model-settings',
        { models: [{ provider: 'openai', modelId: 'gpt-4', inputPricePerM: 30 }] },
        config,
        env,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ name: string; models?: unknown[] }>;
      expect(savedProviders[0]?.models).to.deep.equal([{ id: 'gpt-4', inputPricePerM: 30 }]);
    });

    it('edits an existing model entry without disturbing a sibling model on the same provider [unit]', async () => {
      writeYaml(tmpDir, {
        providers: [
          {
            name: 'local',
            type: 'ollama',
            models: [
              { id: 'llama3', temperature: 0.5 },
              { id: 'qwen3', temperature: 0.2 },
            ],
          },
        ],
      });
      const config = makeConfig(tmpDir);
      const env = makeEnv({
        providers: [
          {
            name: 'local',
            type: 'ollama',
            models: [
              { id: 'llama3', temperature: 0.5 },
              { id: 'qwen3', temperature: 0.2 },
            ],
          },
        ],
      });
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'model-settings',
        {
          models: [
            { provider: 'local', modelId: 'llama3', temperature: 1 },
            { provider: 'local', modelId: 'qwen3', temperature: 0.2 },
          ],
        },
        config,
        env,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ name: string; models?: unknown[] }>;
      expect(savedProviders[0]?.models).to.deep.equal([
        { id: 'llama3', temperature: 1 },
        { id: 'qwen3', temperature: 0.2 },
      ]);
    });

    it('deletes a model entry omitted from the submitted list, leaving other providers untouched [unit]', async () => {
      writeYaml(tmpDir, {
        providers: [
          { name: 'local', type: 'ollama', models: [{ id: 'llama3', temperature: 0.5 }] },
          { name: 'openai', type: 'openai', models: [{ id: 'gpt-4', inputPricePerM: 30 }] },
        ],
      });
      const config = makeConfig(tmpDir);
      const env = makeEnv({
        providers: [
          { name: 'local', type: 'ollama', models: [{ id: 'llama3', temperature: 0.5 }] },
          { name: 'openai', type: 'openai', models: [{ id: 'gpt-4', inputPricePerM: 30 }] },
        ],
      });
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      // The UI always resubmits every row it didn't delete: here it deletes
      // local's only model (omitted entirely) while resubmitting openai's
      // row unchanged.
      const result = await patchSettingsSectionHandler(
        'model-settings',
        { models: [{ provider: 'openai', modelId: 'gpt-4', inputPricePerM: 30 }] },
        config,
        env,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ name: string; models?: unknown[] }>;
      expect(savedProviders.find((p) => p.name === 'local')?.models).to.deep.equal([]);
      expect(savedProviders.find((p) => p.name === 'openai')?.models).to.deep.equal([
        { id: 'gpt-4', inputPricePerM: 30 },
      ]);
    });

    it('leaves a provider with no model config at all untouched when it is not part of the submission [unit]', async () => {
      writeYaml(tmpDir, {
        providers: [
          { name: 'local', type: 'ollama' },
          { name: 'openai', type: 'openai', models: [{ id: 'gpt-4', inputPricePerM: 30 }] },
        ],
      });
      const config = makeConfig(tmpDir);
      const env = makeEnv({
        providers: [
          { name: 'local', type: 'ollama' },
          { name: 'openai', type: 'openai', models: [{ id: 'gpt-4', inputPricePerM: 30 }] },
        ],
      });
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'model-settings',
        { models: [{ provider: 'openai', modelId: 'gpt-4', inputPricePerM: 30 }] },
        config,
        env,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      const savedProviders = written.providers as Array<{ name: string; models?: unknown[] }>;
      expect(savedProviders.find((p) => p.name === 'local')?.models).to.equal(undefined);
    });

    it('rejects a model entry referencing an unknown provider [unit]', async () => {
      const config = makeConfig(tmpDir);
      const env = makeEnv({ providers: [{ name: 'openai', type: 'openai' }] });
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'model-settings',
        { models: [{ provider: 'not-configured', modelId: 'x' }] },
        config,
        env,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(false);
    });

    it('does not call side effects when PATCH fails validation [unit]', async () => {
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();
      await patchSettingsSectionHandler(
        'general',
        { logLevel: 99 },
        makeConfig(tmpDir),
        makeEnv(),
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );
      expect(calls).to.deep.equal([]);
    });
  });

  describe('validateFavoriteModels()', () => {
    it('accepts favorites whose providers all exist [unit]', () => {
      const errors = validateFavoriteModels(
        [
          { provider: 'do', model: 'a' },
          { provider: 'local', model: 'b' },
        ],
        ['do', 'local'],
      );
      expect(errors).to.deep.equal([]);
    });

    it('reports a favorite pointing at a provider that is not configured [unit]', () => {
      const errors = validateFavoriteModels([{ provider: 'gone', model: 'a' }], ['do']);
      expect(errors).to.have.length(1);
      expect(errors[0]).to.include('unknown provider "gone"');
    });

    it('reports the same provider/model pair listed twice [unit]', () => {
      const errors = validateFavoriteModels(
        [
          { provider: 'do', model: 'a' },
          { provider: 'do', model: 'a' },
        ],
        ['do'],
      );
      expect(errors).to.have.length(1);
      expect(errors[0]).to.include('Duplicate favorite "do / a"');
    });

    it('treats the same model under different providers as distinct favorites [unit]', () => {
      const errors = validateFavoriteModels(
        [
          { provider: 'do', model: 'a' },
          { provider: 'local', model: 'a' },
        ],
        ['do', 'local'],
      );
      expect(errors).to.deep.equal([]);
    });
  });

  describe('model-providers favoriteModels', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-favorites-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const noop = async () => {};
    const noopSync = () => {};

    function patch(body: unknown, env: EnvAccessor) {
      return patchSettingsSectionHandler(
        'model-providers',
        body,
        makeConfig(tmpDir),
        env,
        noop,
        noopSync,
        noopSync,
        noopSync,
      );
    }

    const storedProviders: EnvAccessor['providers'] = [
      { name: 'do', type: 'openai' },
      { name: 'local', type: 'ollama' },
    ];

    it('includes the stored favorites in the GET response so the panel can render them [unit]', () => {
      const favoriteModels = [{ provider: 'do', model: 'llama' }];
      const result = getSettingsSectionHandler(
        'model-providers',
        makeEnv({ providers: storedProviders, favoriteModels }),
        makeConfig(tmpDir),
      );
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect((result.data as { favoriteModels: unknown }).favoriteModels).to.deep.equal(
          favoriteModels,
        );
      }
    });

    it('persists favoriteModels to config.yaml in the submitted order [unit]', async () => {
      const favoriteModels = [
        { provider: 'local', model: 'qwen3:14b' },
        { provider: 'do', model: 'llama' },
      ];
      const result = await patch({ favoriteModels }, makeEnv({ providers: storedProviders }));
      expect(result.ok).to.equal(true);
      expect(readYaml(tmpDir).favoriteModels).to.deep.equal(favoriteModels);
    });

    it('accepts a favorite whose model is not known, since models are only checked live in the UI [unit]', async () => {
      const result = await patch(
        { favoriteModels: [{ provider: 'do', model: 'retired-model' }] },
        makeEnv({ providers: storedProviders }),
      );
      expect(result.ok).to.equal(true);
    });

    it('rejects a favorite naming an unknown provider and leaves config.yaml untouched [unit]', async () => {
      writeYaml(tmpDir, { favoriteModels: [{ provider: 'do', model: 'llama' }] });
      const result = await patch(
        { favoriteModels: [{ provider: 'nope', model: 'x' }] },
        makeEnv({ providers: storedProviders }),
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.fieldErrors?.favoriteModels).to.have.length(1);
      }
      expect(readYaml(tmpDir).favoriteModels).to.deep.equal([{ provider: 'do', model: 'llama' }]);
    });

    it('rejects duplicate provider/model pairs [unit]', async () => {
      const result = await patch(
        {
          favoriteModels: [
            { provider: 'do', model: 'llama' },
            { provider: 'do', model: 'llama' },
          ],
        },
        makeEnv({ providers: storedProviders }),
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.fieldErrors?.favoriteModels).to.have.length(1);
    });

    it('validates favorites against incoming providers so a rename and its favorites save together [unit]', async () => {
      const result = await patch(
        {
          providers: [{ name: 'do-renamed', type: 'openai' }],
          favoriteModels: [{ provider: 'do-renamed', model: 'llama' }],
        },
        makeEnv({ providers: [{ name: 'do', type: 'openai' }] }),
      );
      expect(result.ok).to.equal(true);
      expect(readYaml(tmpDir).favoriteModels).to.deep.equal([
        { provider: 'do-renamed', model: 'llama' },
      ]);
    });

    it('rejects a providers-only patch that would orphan stored favorites [unit]', async () => {
      const result = await patch(
        { providers: [{ name: 'local', type: 'ollama' }] },
        makeEnv({
          providers: storedProviders,
          favoriteModels: [{ provider: 'do', model: 'llama' }],
        }),
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.fieldErrors?.favoriteModels?.[0]).to.include('"do"');
      expect(readYaml(tmpDir).providers).to.equal(undefined);
    });

    it('does not validate favorites when only defaultProvider changes, so stale hand-edits cannot block it [unit]', async () => {
      const result = await patch(
        { defaultProvider: 'local' },
        makeEnv({
          providers: storedProviders,
          favoriteModels: [{ provider: 'gone', model: 'x' }],
        }),
      );
      expect(result.ok).to.equal(true);
    });
  });
});
