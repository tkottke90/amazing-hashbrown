import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import { bootToolSettingsStore, getToolSettingsStore } from '../services/tool-settings-store.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import { toolAccessMiddleware } from './tool-access.middleware.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeTool(name: string): any {
  return { name };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRequest(toolNames: string[], threadId?: string): any {
  return {
    tools: toolNames.map(fakeTool),
    runtime: { configurable: threadId ? { thread_id: threadId } : {} },
  };
}

async function runMiddleware(request: unknown): Promise<string[]> {
  let seen: string[] = [];
  const handler = async (req: { tools: { name: string }[] }) => {
    seen = req.tools.map((t) => t.name);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return undefined as any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (toolAccessMiddleware as any).wrapModelCall(request, handler);
  return seen;
}

describe('agents/tool-access.middleware', () => {
  let dir: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-access-middleware-test-'));
    db = openDatabase(join(dir, 'test.db'));
    bootThreadStore(db);
    bootToolSettingsStore(db);
    getToolSettingsStore().seedCatalogDefaults(TOOL_CATALOG);
    getThreadStore().upsertThreadOnFirstMessage('t1', 'hi');
    getThreadStore().upsertThreadOnFirstMessage('t2', 'hi');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes every tool through unfiltered when there is no thread id', async () => {
    const seen = await runMiddleware(fakeRequest(['web_fetch', 'wiki_search']));
    expect(seen).to.deep.equal(['web_fetch', 'wiki_search']);
  });

  it('always-on wiki tools pass through regardless of settings', async () => {
    const seen = await runMiddleware(fakeRequest(['wiki_search', 'wiki_create_page'], 't1'));
    expect(seen).to.include.members(['wiki_search', 'wiki_create_page']);
  });

  it('always-on complete_task passes through even for a non-customized thread', async () => {
    const seen = await runMiddleware(fakeRequest(['complete_task'], 't1'));
    expect(seen).to.deep.equal(['complete_task']);
  });

  it('a globally-disabled built-in tool is filtered out even though nothing thread-specific changed', async () => {
    getToolSettingsStore().patch('shell_exec', { enabled: false });
    const seen = await runMiddleware(fakeRequest(['web_fetch', 'shell_exec'], 't1'));
    expect(seen).to.deep.equal(['web_fetch']);
  });

  it('a globally-enabled tool the thread has not selected is filtered out once the thread is customized', async () => {
    getToolSettingsStore().setThreadTools('t1', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t1');
    const seen = await runMiddleware(fakeRequest(['web_fetch', 'shell_exec'], 't1'));
    expect(seen).to.deep.equal(['shell_exec']);
  });

  it('does not bleed one thread\'s customization into another thread on the same middleware instance', async () => {
    getToolSettingsStore().setThreadTools('t1', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t1');
    // t2 was never customized — it must still see live global defaults,
    // not t1's snapshot. This is the regression test for the agent-cache
    // risk this middleware's design exists to avoid (see its own doc
    // comment): a thread-specific Set baked in at build time would leak
    // across threads sharing a cached agent; reading runtime.configurable
    // fresh per call, as this middleware does, cannot leak that way.
    const seenT1 = await runMiddleware(fakeRequest(['web_fetch', 'shell_exec'], 't1'));
    const seenT2 = await runMiddleware(fakeRequest(['web_fetch', 'shell_exec'], 't2'));
    expect(seenT1).to.deep.equal(['shell_exec']);
    expect(seenT2).to.deep.equal(['web_fetch', 'shell_exec']);
  });

  it('a skill-gated tool passes through even for a customized thread that never selected it', async () => {
    // create_workspace has no checkbox in the Edit Tools drawer, so a
    // thread's saved snapshot never contains it — customizing t1 to select
    // only shell_exec must not cause an ACTIVE skill-gated tool (one
    // skillGatedToolsMiddleware already let through this turn, earlier in
    // the real middleware chain) to get wrongly stripped back out here.
    getToolSettingsStore().setThreadTools('t1', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t1');
    const seen = await runMiddleware(fakeRequest(['shell_exec', 'create_workspace'], 't1'));
    expect(seen).to.deep.equal(['shell_exec', 'create_workspace']);
  });

  it('a skill-gated tool passes through for a non-customized thread too', async () => {
    const seen = await runMiddleware(fakeRequest(['create_workspace'], 't1'));
    expect(seen).to.deep.equal(['create_workspace']);
  });
});
