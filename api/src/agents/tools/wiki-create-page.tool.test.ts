import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { ThreadStore } from '../../services/thread-store.js';
import { setActiveSseWriter, clearActiveSseWriter } from '../active-sse-writer.js';
import { makeWikiCreatePageTool } from './wiki-create-page.tool.js';

const THREAD_ID = 'test-thread';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: { thread_id: THREAD_ID }, toolCallId: 'call-1' };
}

describe('agents/tools/wiki-create-page', () => {
  let store: WorkspaceStore;
  let threadStore: ThreadStore;
  let registry: WikiRegistry;
  let dir: string;
  let sseEvents: ChatSSEEvent[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-create-page-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
    threadStore = new ThreadStore(db);
    // A global chat thread — write scope resolves to "open", so these
    // tests exercise the tool's own behavior, not the scope rules.
    threadStore.upsertThreadOnFirstMessage(THREAD_ID, 'test', 'chat');
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
    const tool = makeWikiCreatePageTool(registry, store, threadStore);

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
    const tool = makeWikiCreatePageTool(registry, store, threadStore);
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
    const tool = makeWikiCreatePageTool(registry, store, threadStore);

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

  describe('write scope (resolved per call from the thread) [#202]', () => {
    const page = {
      title: 'Stream Backpressure',
      corpus: { raw: 'Use stream.pipeline(). See [[dns]] and [[network]].' },
      section: 'concept' as const,
    };

    function workspaceThread(name: string, wikiId?: string) {
      const ws = store.createWorkspace({ name, location: join(dir, name), wikiId });
      const threadId = `thread-${name}`;
      threadStore.upsertThreadOnFirstMessage(threadId, name, 'workspace-chat');
      store.patchWorkspace(ws.id, { threadId });
      return { ws, threadId };
    }

    beforeEach(async () => {
      await registry.create({ id: 'video-streaming', domain: 'video streaming', tags: [] });
      await registry.create({ id: 'image-archive', domain: 'image archive', tags: [] });
    });

    it('rejects a wiki bound to another workspace *after* the tool was built [orchestration]', async () => {
      // Agents are cached per workspace, so the tool must see bindings made
      // after it was constructed — a captured value would let this through.
      const { threadId } = workspaceThread('scratch');
      const tool = makeWikiCreatePageTool(registry, store, threadStore);
      workspaceThread('video', 'video-streaming');

      const result = await tool.invoke(
        { ...page, wikiId: 'video-streaming' },
        { configurable: { thread_id: threadId } },
      );
      expect(result).to.contain('"video-streaming" belongs to another workspace');
      expect(sseEvents, 'a rejected write must not announce a wiki update').to.have.length(0);
    });

    it('locks a bound non-project workspace to its own wiki [orchestration]', async () => {
      const { threadId } = workspaceThread('image', 'image-archive');
      const tool = makeWikiCreatePageTool(registry, store, threadStore);

      const rejected = await tool.invoke(
        { ...page, wikiId: 'test-wiki' },
        { configurable: { thread_id: threadId } },
      );
      expect(rejected).to.contain('restricted to writing wiki "image-archive"');

      const written = await tool.invoke(
        { ...page, wikiId: 'image-archive' },
        { configurable: { thread_id: threadId } },
      );
      expect(written).to.contain('Created page');
    });

    it("applies a workspace-scoped task run's workspace lock on the task's own thread [orchestration]", async () => {
      const { ws } = workspaceThread('image', 'image-archive');
      const task = store.createTask({ title: 'capture notes', workspaceId: ws.id });
      threadStore.upsertThreadOnFirstMessage('run-thread', 'run', 'task');
      store.patchTask(task.id, { threadId: 'run-thread' });
      const tool = makeWikiCreatePageTool(registry, store, threadStore);

      const result = await tool.invoke(
        { ...page, wikiId: 'test-wiki' },
        { configurable: { thread_id: 'run-thread' } },
      );
      expect(result).to.contain('restricted to writing wiki "image-archive"');
    });

    it('fails closed for a thread that cannot be placed [orchestration]', async () => {
      const tool = makeWikiCreatePageTool(registry, store, threadStore);
      const result = await tool.invoke(
        { ...page, wikiId: 'test-wiki' },
        { configurable: { thread_id: 'no-such-thread' } },
      );
      expect(result).to.contain('could not be determined');
    });
  });
});
