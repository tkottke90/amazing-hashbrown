import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { getToolContent } from '../../services/tool-content-store.js';
import { STUB_THRESHOLD_CHARS } from './tool-stub.js';
import { webFetchTool } from './web-fetch.tool.js';

// Scoped deliberately to just the offload/stub branch — web_fetch has no
// other test coverage in this repo today (robots-blocked, error status,
// small-content passthrough, HTML metadata/links/outline extraction are all
// pre-existing gaps, out of scope for this change).

// Same stubbing idiom as services/web-fetch.test.ts's installFetchStub —
// this repo has no sinon, and fetchUrl has no DI seam, so the network
// primitive itself is stubbed one level down.
function installFetchStub(respondToMain: (url: string) => Response): () => void {
  const original = global.fetch;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/robots.txt')) {
      return new Response('', { status: 404 });
    }
    return respondToMain(url);
  }) as typeof fetch;
  return () => {
    global.fetch = original;
  };
}

describe('agents/tools/web-fetch', () => {
  let restoreFetch: (() => void) | null = null;

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  it('offloads to a stub whose chars field matches the real stored content, not just the article text [unit]', async () => {
    // text/plain is returned by fetchUrl() as-is (metadata: {}, links: [],
    // outline: []), so fullContent is exactly '## Content\n' + body —
    // deterministic, no HTML/readability extraction involved.
    const body = 'x'.repeat(STUB_THRESHOLD_CHARS + 500);
    restoreFetch = installFetchStub(
      () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    const result = (await webFetchTool.invoke(
      { url: 'https://example.com/big' },
      { configurable: { thread_id: 'thread-web-fetch-1' } },
    )) as unknown as string;

    const fullContent = `## Content\n${body}`;

    expect(result).to.include('── CONTENT OFFLOADED ──');
    // The explicit regression check: chars reflects fullContent (what's
    // actually stored and retrievable), not result.text alone.
    expect(result).to.include(`chars: ${fullContent.length}`);
    expect(result).to.include(`lines: ${fullContent.split('\n').length}`);

    const toolKeyMatch = result.match(/key:\s*(\S+)/);
    expect(toolKeyMatch, 'expected a key to be present in the stub').to.not.equal(null);
    const stored = getToolContent('thread-web-fetch-1', toolKeyMatch![1]!);
    expect(stored).to.equal(fullContent);
  });
});
