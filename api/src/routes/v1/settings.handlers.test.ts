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

    it('returns costs record for cost-rates [unit]', () => {
      const envWithCosts = makeEnv({
        costs: {
          'gpt-4': {
            inputPer1kTokens: 0.03,
            inputScale: '1k',
            outputPer1kTokens: 0.06,
            outputScale: '1k',
          },
        },
      });
      const result = getSettingsSectionHandler('cost-rates', envWithCosts, makeConfig(tmpDir));
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const data = result.data as { costs: Record<string, unknown> };
        expect(data.costs['gpt-4']).to.deep.equal({
          inputPer1kTokens: 0.03,
          inputScale: '1k',
          outputPer1kTokens: 0.06,
          outputScale: '1k',
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

    it('writes cost-rates and returns updated costs [unit]', async () => {
      const config = makeConfig(tmpDir);
      const envEmpty = makeEnv({ costs: {} });
      const {
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      } = makeSideEffects();

      const result = await patchSettingsSectionHandler(
        'cost-rates',
        { costs: { 'gpt-4': { inputPer1kTokens: 0.03, outputPer1kTokens: 0.06 } } },
        config,
        envEmpty,
        loadAgentInstructions,
        invalidateChatAgent,
        seedProviderCosts,
        reloadTrackerRegistry,
      );

      expect(result.ok).to.equal(true);
      const written = readYaml(tmpDir);
      expect((written.costs as Record<string, unknown>)['gpt-4']).to.deep.equal({
        inputPer1kTokens: 0.03,
        inputScale: '1k',
        outputPer1kTokens: 0.06,
        outputScale: '1k',
      });
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
