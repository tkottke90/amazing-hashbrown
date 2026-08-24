import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { fetchUrl } from './web-fetch.js';

// fetchUrl() issues up to two fetch() calls per invocation: env.webFetch.respectRobotsTxt
// defaults to true (see api/src/config/env.ts), so getRobots() fetches `${origin}/robots.txt`
// BEFORE the main URL fetch. This stub branches on that so each test only has to describe
// the response for the URL under test — robots.txt always resolves to a 404, which getRobots()
// treats as "no rules" and therefore allows the request through.
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

describe('services/web-fetch', () => {
  let restoreFetch: (() => void) | null = null;

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  describe('fetchUrl()', () => {
    it('returns the raw body unmodified for a text/markdown response [external-orchestration]', async () => {
      const body = '# Hello\n\nThis is **markdown**.\n';
      restoreFetch = installFetchStub(
        () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/markdown; charset=utf-8' },
          }),
      );

      const result = await fetchUrl('https://example.com/doc.md');

      if (result.status !== 'ok') {
        throw new Error(`expected status "ok", got "${result.status}"`);
      }
      expect(result.contentType).to.equal('markdown');
      expect(result.text).to.equal(body);
      expect(result.metadata).to.deep.equal({});
      expect(result.links).to.deep.equal([]);
      expect(result.outline).to.deep.equal([]);
    });

    it('returns the raw body unmodified for a text/plain response [external-orchestration]', async () => {
      const body = 'Just plain text notes.\nLine two.\n';
      restoreFetch = installFetchStub(
        () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          }),
      );

      const result = await fetchUrl('https://example.com/notes.txt');

      if (result.status !== 'ok') {
        throw new Error(`expected status "ok", got "${result.status}"`);
      }
      expect(result.contentType).to.equal('markdown');
      expect(result.text).to.equal(body);
      expect(result.metadata).to.deep.equal({});
      expect(result.links).to.deep.equal([]);
      expect(result.outline).to.deep.equal([]);
    });

    it('still pretty-prints application/json responses (regression) [external-orchestration]', async () => {
      const raw = '{"b":2,"a":1}';
      restoreFetch = installFetchStub(
        () =>
          new Response(raw, {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          }),
      );

      const result = await fetchUrl('https://example.com/api/data');

      if (result.status !== 'ok') {
        throw new Error(`expected status "ok", got "${result.status}"`);
      }
      expect(result.contentType).to.equal('json');
      expect(result.text).to.equal('{\n  "b": 2,\n  "a": 1\n}');
    });

    it('still parses text/html via Readability and populates metadata/links/outline (regression) [external-orchestration]', async () => {
      const html = `<!doctype html>
<html>
  <head>
    <title>Fallback Title</title>
    <meta property="og:title" content="Example Article" />
    <meta property="og:description" content="An example description for the article." />
  </head>
  <body>
    <article>
      <h1>Example Article</h1>
      <p>This is the first paragraph of the example article, and it contains enough text to give Readability something substantial to work with when it extracts the main content of the page.</p>
      <h2>Background</h2>
      <p>This second paragraph continues the article with more filler content so that the parsed text block is long enough for Readability's heuristics to treat it as the primary content region rather than discarding it as boilerplate.</p>
      <h3>Details</h3>
      <p>A third paragraph rounds out the article body, again padded with enough words to comfortably clear Readability's default content-length threshold during extraction.</p>
      <a href="https://example.com/related-one">Related One</a>
      <a href="https://example.com/related-two">Related Two</a>
    </article>
  </body>
</html>`;
      restoreFetch = installFetchStub(
        () =>
          new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      );

      const result = await fetchUrl('https://example.com/article');

      if (result.status !== 'ok') {
        throw new Error(`expected status "ok", got "${result.status}"`);
      }
      expect(result.contentType).to.equal('html');
      expect(result.metadata.title).to.equal('Example Article');
      expect(result.metadata.description).to.equal('An example description for the article.');
      expect(result.links).to.deep.equal([
        { text: 'Related One', href: 'https://example.com/related-one' },
        { text: 'Related Two', href: 'https://example.com/related-two' },
      ]);
      expect(result.outline).to.deep.equal([
        { level: 1, text: 'Example Article' },
        { level: 2, text: 'Background' },
        { level: 3, text: 'Details' },
      ]);
      expect(result.text).to.be.a('string');
      expect(result.text.length).to.be.greaterThan(0);
      expect(result.text).to.include('first paragraph of the example article');
    });

    it('rejects an unsupported content type with an error result (regression) [external-orchestration]', async () => {
      restoreFetch = installFetchStub(
        () =>
          new Response('', {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
      );

      const result = await fetchUrl('https://example.com/photo.png');

      if (result.status !== 'error') {
        throw new Error(`expected status "error", got "${result.status}"`);
      }
      expect(result.error).to.equal('Unsupported content type: image/png');
    });
  });
});
