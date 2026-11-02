import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import type { UserMessageWikiReference } from '@tkottke90/llm-common-types/chat';
import { createWikiReferenceExpansionMiddleware } from './wiki-reference-expansion.middleware.js';
import { createWikiPage } from '../services/wiki-write.js';
import { getToolContent } from '../services/tool-content-store.js';
import { STUB_THRESHOLD_CHARS } from './tools/tool-stub.js';

const THREAD_ID = 'test-thread';

function makeState(messages: BaseMessage[]): { messages: BaseMessage[] } {
  return { messages };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(wikiReferences?: UserMessageWikiReference[], threadId = THREAD_ID): any {
  return {
    configurable: { thread_id: threadId, ...(wikiReferences ? { wikiReferences } : {}) },
  };
}

interface BeforeAgentResult {
  messages: BaseMessage[];
}

async function callBeforeAgent(
  middleware: ReturnType<typeof createWikiReferenceExpansionMiddleware>,
  state: { messages: BaseMessage[] },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runtime: any,
): Promise<BeforeAgentResult | undefined> {
  const hook = middleware.beforeAgent;
  if (typeof hook !== 'function') throw new Error('test setup error: no beforeAgent hook');
  return hook(state, runtime) as Promise<BeforeAgentResult | undefined>;
}

describe('agents/wiki-reference-expansion.middleware [unit]', () => {
  let dir: string;
  let registry: WikiRegistry;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-reference-expansion-middleware-test-'));
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    await registry.create({ id: 'test-wiki', domain: 'testing', tags: [] });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function middlewareUnderTest() {
    return createWikiReferenceExpansionMiddleware(async () => registry);
  }

  it('returns undefined when there is no wikiReferences in configurable', async () => {
    const result = await callBeforeAgent(
      middlewareUnderTest(),
      makeState([new HumanMessage('hello')]),
      makeRuntime(undefined),
    );
    expect(result).to.equal(undefined);
  });

  it('returns undefined for an empty wikiReferences array', async () => {
    const result = await callBeforeAgent(
      middlewareUnderTest(),
      makeState([new HumanMessage('hello')]),
      makeRuntime([]),
    );
    expect(result).to.equal(undefined);
  });

  it('returns undefined when there is no human message to rewrite', async () => {
    const result = await callBeforeAgent(
      middlewareUnderTest(),
      makeState([new AIMessage('hi there')]),
      makeRuntime([{ wikiId: 'test-wiki', path: 'entities/router.md', title: 'Router' }]),
    );
    expect(result).to.equal(undefined);
  });

  it('appends the full, untruncated page content plus a citation line for a resolvable reference', async () => {
    const created = await createWikiPage(
      {
        wikiId: 'test-wiki',
        title: 'Router',
        content: 'A router at home.',
        section: 'entity',
        tags: ['networking'],
      },
      registry,
    );
    expect(created.status).to.equal('written');
    const path = created.status === 'written' ? created.result.path : '';

    const original = new HumanMessage({ content: 'edit that page', id: 'msg-1' });
    const result = await callBeforeAgent(
      middlewareUnderTest(),
      makeState([original]),
      makeRuntime([{ wikiId: 'test-wiki', path, title: 'Router' }]),
    );

    expect(result!.messages[0]!.id).to.equal('msg-1');
    const content = result!.messages[0]!.content as string;
    expect(content).to.include('edit that page');
    expect(content).to.include(`Wiki Reference — Wiki Domain "test-wiki", path "${path}":`);
    expect(content).to.include('# Router');
    expect(content).to.include('Type: entity');
    expect(content).to.include('Tags: networking');
    expect(content).to.include('A router at home.');
  });

  it('offloads a page beyond STUB_THRESHOLD_CHARS to the tool-content store with a get_tool_key hint, instead of inlining it', async () => {
    const hugeContent = 'x'.repeat(STUB_THRESHOLD_CHARS + 1000);
    const created = await createWikiPage(
      {
        wikiId: 'test-wiki',
        title: 'Huge Page',
        content: hugeContent,
        section: 'entity',
      },
      registry,
    );
    expect(created.status).to.equal('written');
    const path = created.status === 'written' ? created.result.path : '';

    const original = new HumanMessage({ content: 'about that page', id: 'msg-2' });
    const result = await callBeforeAgent(
      middlewareUnderTest(),
      makeState([original]),
      makeRuntime([{ wikiId: 'test-wiki', path, title: 'Huge Page' }]),
    );

    const content = result!.messages[0]!.content as string;
    expect(content).to.not.include(hugeContent);
    expect(content).to.include('CONTENT OFFLOADED');
    expect(content).to.include('get_tool_key');

    const toolKeyMatch = content.match(/toolKey:\s*"([^"]+)"/);
    expect(toolKeyMatch, 'expected a toolKey to be present in the stub').to.not.equal(null);
    const stored = getToolContent(THREAD_ID, toolKeyMatch![1]!);
    expect(stored).to.include(hugeContent);
  });

  it('degrades to a "no longer exists" notation when the page cannot be read, instead of throwing', async () => {
    const original = new HumanMessage({ content: 'edit that page', id: 'msg-3' });
    const result = await callBeforeAgent(
      middlewareUnderTest(),
      makeState([original]),
      makeRuntime([
        { wikiId: 'test-wiki', path: 'entities/does-not-exist.md', title: 'Ghost Page' },
      ]),
    );

    const content = result!.messages[0]!.content as string;
    expect(content).to.include(
      '[The user referenced wiki page "Ghost Page" (test-wiki/entities/does-not-exist.md) but it no longer exists.]',
    );
  });

  it('degrades the same way when the wikiId itself is not a registered domain', async () => {
    const original = new HumanMessage({ content: 'edit that page', id: 'msg-4' });
    const result = await callBeforeAgent(
      middlewareUnderTest(),
      makeState([original]),
      makeRuntime([{ wikiId: 'no-such-domain', path: 'entities/foo.md', title: 'Foo' }]),
    );

    const content = result!.messages[0]!.content as string;
    expect(content).to.include(
      '[The user referenced wiki page "Foo" (no-such-domain/entities/foo.md) but it no longer exists.]',
    );
  });

  it('appends after content a preceding middleware (e.g. skill expansion) already produced, rather than replacing it', async () => {
    const created = await createWikiPage(
      { wikiId: 'test-wiki', title: 'Router', content: 'A router.', section: 'entity' },
      registry,
    );
    expect(created.status).to.equal('written');
    const path = created.status === 'written' ? created.result.path : '';

    const alreadyExpanded = new HumanMessage({
      content: 'skill body\n\nuser args',
      id: 'msg-5',
    });
    const result = await callBeforeAgent(
      middlewareUnderTest(),
      makeState([alreadyExpanded]),
      makeRuntime([{ wikiId: 'test-wiki', path, title: 'Router' }]),
    );

    const content = result!.messages[0]!.content as string;
    expect(content.startsWith('skill body\n\nuser args')).to.equal(true);
    expect(content).to.include('A router.');
  });

  it('only rewrites the last human message when several messages are present', async () => {
    const created = await createWikiPage(
      { wikiId: 'test-wiki', title: 'Router', content: 'A router.', section: 'entity' },
      registry,
    );
    expect(created.status).to.equal('written');
    const path = created.status === 'written' ? created.result.path : '';

    const first = new HumanMessage({ content: 'first turn', id: 'msg-1' });
    const ai = new AIMessage('first reply');
    const second = new HumanMessage({ content: 'second turn', id: 'msg-2' });
    const result = await callBeforeAgent(
      middlewareUnderTest(),
      makeState([first, ai, second]),
      makeRuntime([{ wikiId: 'test-wiki', path, title: 'Router' }]),
    );

    expect(result!.messages[0]).to.equal(first);
    expect(result!.messages[1]).to.equal(ai);
    expect(result!.messages[2]!.content).to.include('second turn');
  });
});
