import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { SystemMessage } from '@langchain/core/messages';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import type { ModelInputParams } from '@tkottke90/observability';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import { bootToolSettingsStore, getToolSettingsStore } from '../services/tool-settings-store.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import { GATED_SKILL_REGISTRATIONS } from './gated-skill-registrations.js';
import { createSkillGatedToolsMiddleware } from './skill-gated-tools.middleware.js';
import { createToolAccessMiddleware } from './tool-access.middleware.js';
import { createModelInputSnapshotMiddleware } from './model-input-snapshot.middleware.js';
import type { ToolEntry } from '../config/env.js';

enum TestTypes {
  UNIT = '[unit]',
  ORCHESTRATION = '[orchestration]',
}

interface RecordedCall {
  traceId: string;
  params: ModelInputParams;
}

function fakeStore() {
  const calls: RecordedCall[] = [];
  return {
    calls,
    store: {
      recordModelInput: (traceId: string, params: ModelInputParams) => {
        calls.push({ traceId, params });
      },
    },
  };
}

function fakeRequest(opts: {
  toolNames: string[];
  traceId?: string;
  threadId?: string;
  system?: SystemMessage;
  activeGatedSkill?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  return {
    tools: opts.toolNames.map((name) => ({ name })),
    runtime: {
      configurable: {
        ...(opts.threadId ? { thread_id: opts.threadId } : {}),
        ...(opts.traceId ? { trace_id: opts.traceId } : {}),
      },
    },
    systemMessage: opts.system ?? new SystemMessage('effective prompt'),
    state: { activeGatedSkill: opts.activeGatedSkill ?? null, requestedToolIds: [] },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMiddleware = any;

describe('agents/model-input-snapshot.middleware', () => {
  it(`records the bound tool names and string system prompt against the trace ${TestTypes.UNIT}`, async () => {
    const { calls, store } = fakeStore();
    const middleware: AnyMiddleware = createModelInputSnapshotMiddleware(() => store);

    await middleware.wrapModelCall(
      fakeRequest({ toolNames: ['wiki_search', 'web_fetch'], traceId: 'trace-1' }),
      async () => ({}),
    );

    expect(calls).to.deep.equal([
      {
        traceId: 'trace-1',
        params: { tools: ['wiki_search', 'web_fetch'], systemPrompt: 'effective prompt' },
      },
    ]);
  });

  it(`hands the request to the handler unmodified and returns its result ${TestTypes.UNIT}`, async () => {
    const { store } = fakeStore();
    const middleware: AnyMiddleware = createModelInputSnapshotMiddleware(() => store);
    const request = fakeRequest({ toolNames: ['wiki_search'], traceId: 'trace-1' });
    const response = { marker: 'model-response' };
    let seen: unknown;

    const result = await middleware.wrapModelCall(request, async (req: unknown) => {
      seen = req;
      return response;
    });

    expect(seen, 'snapshotting must not alter what the model receives').to.equal(request);
    expect(result).to.equal(response);
  });

  it(`records nothing when the call carries no trace id ${TestTypes.UNIT}`, async () => {
    const { calls, store } = fakeStore();
    const middleware: AnyMiddleware = createModelInputSnapshotMiddleware(() => store);
    let handled = false;

    await middleware.wrapModelCall(fakeRequest({ toolNames: ['wiki_search'] }), async () => {
      handled = true;
      return {};
    });

    expect(calls).to.have.length(0);
    expect(handled).to.equal(true);
  });

  it(`still completes the model call when the store throws ${TestTypes.UNIT}`, async () => {
    const middleware: AnyMiddleware = createModelInputSnapshotMiddleware(() => ({
      recordModelInput: () => {
        throw new Error('database is locked');
      },
    }));
    const response = { marker: 'model-response' };

    const result = await middleware.wrapModelCall(
      fakeRequest({ toolNames: ['wiki_search'], traceId: 'trace-1' }),
      async () => response,
    );

    expect(result, 'an observability failure must never fail the chat turn').to.equal(response);
  });

  it(`records tools but no prompt when the system message is not a plain string ${TestTypes.UNIT}`, async () => {
    const { calls, store } = fakeStore();
    const middleware: AnyMiddleware = createModelInputSnapshotMiddleware(() => store);
    const structured = new SystemMessage({ content: [{ type: 'text', text: 'structured' }] });

    await middleware.wrapModelCall(
      fakeRequest({ toolNames: ['wiki_search'], traceId: 'trace-1', system: structured }),
      async () => ({}),
    );

    expect(calls).to.have.length(1);
    expect(calls[0].params.tools).to.deep.equal(['wiki_search']);
    expect(calls[0].params.systemPrompt).to.equal(undefined);
  });

  // The snapshot is only useful if it reflects the list AFTER the real
  // filtering middlewares ran — these tests wire them together in the same
  // order chat-agent.ts does (gated → access → snapshot innermost).
  describe('behind the real tool-filtering middlewares', () => {
    let dir: string;
    let db: SqliteDatabase;
    let toolsConfig: Record<string, ToolEntry>;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'model-input-snapshot-test-'));
      db = openDatabase(join(dir, 'test.db'));
      bootThreadStore(db);
      bootToolSettingsStore(db);
      getToolSettingsStore().seedCatalogDefaults(TOOL_CATALOG);
      getThreadStore().upsertThreadOnFirstMessage('t1', 'hi');
      toolsConfig = {};
    });

    afterEach(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    async function runChain(activeGatedSkill: string | null, toolNames: string[]) {
      const { calls, store } = fakeStore();
      const gated: AnyMiddleware = createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS);
      const access: AnyMiddleware = createToolAccessMiddleware(() => toolsConfig);
      const snapshot: AnyMiddleware = createModelInputSnapshotMiddleware(() => store);

      const request = fakeRequest({
        toolNames,
        threadId: 't1',
        traceId: 'trace-1',
        activeGatedSkill,
      });
      await gated.wrapModelCall(request, (r1: unknown) =>
        access.wrapModelCall(r1, (r2: unknown) => snapshot.wrapModelCall(r2, async () => ({}))),
      );
      expect(calls, 'exactly one snapshot per model call').to.have.length(1);
      return calls[0].params.tools;
    }

    it(`includes a skill-gated tool only on a turn where its skill is active ${TestTypes.ORCHESTRATION}`, async () => {
      const bound = ['wiki_search', 'create_workspace', 'create_project'];

      const baseline = await runChain(null, bound);
      const gatedTurn = await runChain('create-workspace', bound);

      expect(baseline).to.not.include('create_workspace');
      expect(baseline).to.not.include('create_project');
      expect(gatedTurn).to.include('create_workspace');
      expect(gatedTurn, 'only the active skill’s tools are exposed').to.not.include(
        'create_project',
      );
    });

    it(`omits a tool that tool access filtered out for the thread ${TestTypes.ORCHESTRATION}`, async () => {
      toolsConfig['shell_exec'] = { enabled: false };

      const tools = await runChain(null, ['web_fetch', 'shell_exec']);

      expect(tools).to.deep.equal(['web_fetch']);
    });
  });
});
