import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { configManager } from '../config/env.js';
import { bootObservability, getObservabilityStore } from '../services/observability.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';

const DEFAULT_PROVIDER = 'turn-obs-default';
const OTHER_PROVIDER = 'turn-obs-other';

describe('agents/turn-observability', () => {
  before(() => {
    configManager.set('providers', [
      {
        name: DEFAULT_PROVIDER,
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'default-model',
      },
      {
        name: OTHER_PROVIDER,
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'other-model',
      },
    ]);
    configManager.set('defaultProvider', DEFAULT_PROVIDER);
  });

  after(() => {
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  describe('resolveTurnModel', () => {
    it('falls back to the default provider and its defaultModel when given nothing [unit]', () => {
      // The cost-rate key is `${provider}/${model}` — an unresolved model
      // (the #131/#132 bug) can never match a configured rate.
      expect(resolveTurnModel()).to.deep.equal({
        provider: DEFAULT_PROVIDER,
        model: 'default-model',
      });
    });

    it(`keeps an explicit model over the provider's defaultModel [unit]`, () => {
      expect(resolveTurnModel(undefined, 'picked-model')).to.deep.equal({
        provider: DEFAULT_PROVIDER,
        model: 'picked-model',
      });
    });

    it(`resolves an explicit provider to that provider's own defaultModel [unit]`, () => {
      expect(resolveTurnModel(OTHER_PROVIDER)).to.deep.equal({
        provider: OTHER_PROVIDER,
        model: 'other-model',
      });
    });

    it('throws when the provider has no defaultModel and none is given [unit]', () => {
      configManager.set('providers', [
        { name: 'no-default', type: 'ollama', baseUrl: 'http://localhost:11434' },
      ]);
      try {
        expect(() => resolveTurnModel('no-default')).to.throw(/no defaultModel/);
      } finally {
        configManager.set('providers', [
          {
            name: DEFAULT_PROVIDER,
            type: 'ollama',
            baseUrl: 'http://localhost:11434',
            defaultModel: 'default-model',
          },
          {
            name: OTHER_PROVIDER,
            type: 'ollama',
            baseUrl: 'http://localhost:11434',
            defaultModel: 'other-model',
          },
        ]);
      }
    });
  });

  describe('startTurnObservability', () => {
    let dir: string;
    let db: ReturnType<typeof openDatabase>;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'turn-observability-test-'));
      db = openDatabase(join(dir, 'test.db'));
      bootObservability(db);
    });

    afterEach(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    function start() {
      return startTurnObservability({
        threadId: 'thread-1',
        taskId: 'task-1',
        provider: DEFAULT_PROVIDER,
        model: 'default-model',
        source: 'task-run',
        systemPrompt: 'You are a task agent.',
      });
    }

    it(`opens a trace carrying the turn's source, task, thread and resolved model [unit]`, () => {
      const obs = start();
      const trace = getObservabilityStore().getTrace(obs.traceId);
      expect(trace, 'the trace row should exist as soon as the turn starts').to.not.equal(null);
      expect(trace).to.include({
        source: 'task-run',
        taskId: 'task-1',
        threadId: 'thread-1',
        provider: DEFAULT_PROVIDER,
        model: 'default-model',
        systemPrompt: 'You are a task agent.',
        endedAt: null,
      });
    });

    it(`attach() adds the handler and trace_id without dropping the caller's configurable keys [unit]`, () => {
      const obs = start();
      const config = { configurable: { thread_id: 'thread-1', workspaceId: 'ws-1' } };
      const attached = obs.attach(config);

      expect(attached.configurable).to.deep.equal({
        thread_id: 'thread-1',
        workspaceId: 'ws-1',
        // trace_id is what model-input-snapshot.middleware.ts keys the
        // per-turn tool snapshot on (#207).
        trace_id: obs.traceId,
      });
      expect(attached.callbacks).to.deep.equal([obs.obsHandler]);
      expect(config.configurable, 'the caller config must not be mutated').to.not.have.property(
        'trace_id',
      );
    });

    it(`end() closes the trace with the handler's total tokens and the given error [unit]`, async () => {
      const obs = start();
      obs.obsHandler.totalInputTokens = 300;
      obs.obsHandler.totalOutputTokens = 120;

      await obs.end('boom');

      const trace = getObservabilityStore().getTrace(obs.traceId)!;
      expect(trace.totalTokens).to.equal(420);
      expect(trace.error).to.equal('boom');
      expect(trace.endedAt, 'a closed trace has an end time').to.be.a('string');
    });

    it('end() only records the first outcome, so a later cleanup call cannot erase an error [unit]', async () => {
      const obs = start();
      await obs.end('boom');
      await obs.end(null);

      expect(getObservabilityStore().getTrace(obs.traceId)!.error).to.equal('boom');
    });
  });
});
