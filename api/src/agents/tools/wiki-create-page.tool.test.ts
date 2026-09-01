import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { setActiveSseWriter, clearActiveSseWriter } from '../active-sse-writer.js';
import { makeWikiCreatePageTool } from './wiki-create-page.tool.js';

const THREAD_ID = 'test-thread';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: { thread_id: THREAD_ID }, toolCallId: 'call-1' };
}

describe('agents/tools/wiki-create-page', () => {
  let store: WorkspaceStore;
  let registry: WikiRegistry;
  let dir: string;
  let sseEvents: ChatSSEEvent[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-create-page-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    await registry.create({ id: 'test-wiki', domain: 'testing', tags: [] });
    sseEvents = [];
    setActiveSseWriter(THREAD_ID, (event) => sseEvents.push(event));
  });

  afterEach(() => {
    clearActiveSseWriter(THREAD_ID);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a page and emits a wiki_updated event with the real title, pageKind created, and the page path', async () => {
    const tool = makeWikiCreatePageTool(undefined, registry, store);

    await tool.invoke(
      {
        wikiId: 'test-wiki',
        title: 'Router',
        corpus: { raw: 'A router at home.' },
        section: 'entity',
      },
      invokeConfig(),
    );

    expect(sseEvents).to.have.length(1);
    expect(sseEvents[0]).to.deep.equal({
      type: 'wiki_updated',
      pageTitle: 'Router',
      pageKind: 'created',
      wikiName: 'test-wiki',
      path: 'entities/router.md',
    });
  });

  it('does not emit a wiki_updated event on a duplicate page', async () => {
    const tool = makeWikiCreatePageTool(undefined, registry, store);
    const params = {
      wikiId: 'test-wiki',
      title: 'Proxy Notes',
      corpus: { raw: 'The proxy service handles traffic routing.' },
      section: 'entity' as const,
    };

    await tool.invoke(params, invokeConfig());
    expect(sseEvents).to.have.length(1);

    const result = await tool.invoke(params, invokeConfig());

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('already exists');
    expect(sseEvents, 'no additional SSE event on the rejected duplicate attempt').to.have.length(
      1,
    );
  });

  it('does not emit a wiki_updated event on a dry run', async () => {
    const tool = makeWikiCreatePageTool(undefined, registry, store);

    await tool.invoke(
      {
        wikiId: 'test-wiki',
        title: 'DryRun Entity',
        corpus: { raw: 'Some content.' },
        section: 'concept',
        dryRun: true,
      },
      invokeConfig(),
    );

    expect(sseEvents).to.have.length(0);
  });
});
