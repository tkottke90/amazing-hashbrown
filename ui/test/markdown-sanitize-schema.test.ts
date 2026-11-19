// `rehype-raw`/`rehype-sanitize` are mapped to a no-op stub in jest.config.js's
// moduleNameMapper for every other test file's sake (they never need the real
// plugin behavior). A file-scoped jest.mock() always wins over
// moduleNameMapper (see markdown.test.tsx), so this file opts back into the
// real packages via jest.requireActual — the whole point of this test is to
// exercise their actual stripping behavior, not a stub.
jest.mock('rehype-raw', () => jest.requireActual('rehype-raw'));
jest.mock('rehype-sanitize', () => jest.requireActual('rehype-sanitize'));

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { markdownSanitizeSchema } from '../src/lib/markdown-sanitize-schema';

// First test of its kind in this repo: builds the real unified/rehype
// pipeline directly against markdown-with-raw-HTML source strings, bypassing
// `react-markdown` (and its dumb Jest mock) entirely. Necessary because
// `test/__mocks__/react-markdown.tsx` renders `children` into a plain `<div>`
// and ignores `rehypePlugins`/`components` — the Markdown Sanitize Schema's
// stripping behavior can't be exercised through `<Markdown>` in Jest at all.
function render(markdown: string): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, markdownSanitizeSchema)
    .use(rehypeStringify)
    .processSync(markdown);
  return String(file).trim();
}

// TEMPORARY DIAGNOSTIC — every real-pipeline assertion below is failing:
// the raw SVG survives as HTML-entity-escaped text instead of being parsed
// into real elements at all. This logs the tree right after rehypeRaw
// (before sanitize/stringify) to see whether it's still an unexpanded
// `type: 'raw'` node (rehypeRaw never ran) or real `element` nodes with
// `tagName: 'svg'` (rehypeRaw worked, bug is downstream). Remove once the
// real cause is found and the suite below is green again.
function describeShape(value: unknown): { type: string; keys: string[] | null } {
  return {
    type: typeof value,
    keys: value && typeof value === 'object' ? Object.keys(value) : null,
  };
}

describe('DIAGNOSTIC', () => {
  it('logs the hast tree immediately after rehypeRaw [unit]', () => {
    console.log(
      'REHYPE_RAW_SHAPE=' +
        JSON.stringify({
          rehypeRaw: describeShape(rehypeRaw),
          rehypeSanitize: describeShape(rehypeSanitize),
        }),
    );
    const processor = unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw);
    const mdast = processor.parse('<svg><circle cx="1" cy="1" r="1"/></svg>');
    const hastTree = processor.runSync(mdast);

    // Bypass unified's .use()/.run() chaining entirely: call the rehypeRaw
    // attacher directly to get its transformer, then invoke that
    // transformer directly on the EXACT tree captured above (hardcoded) to
    // see whether hast-util-raw itself can expand it in isolation.
    const transformer = rehypeRaw() as (tree: unknown) => unknown;
    console.log('REHYPE_RAW_TRANSFORMER_TYPE=' + typeof transformer);
    const manualTree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [
            { type: 'raw', value: '<svg>' },
            { type: 'raw', value: '<circle cx="1" cy="1" r="1"/>' },
            { type: 'raw', value: '</svg>' },
          ],
        },
      ],
    };
    const manualResult = transformer(manualTree);
    console.log(
      'MANUAL_RESULT_TYPE=' +
        typeof manualResult +
        ' isThenable=' +
        Boolean(manualResult && typeof (manualResult as { then?: unknown }).then === 'function'),
    );
    console.log(
      'MANUAL_TRANSFORMER_RESULT=' +
        JSON.stringify(manualResult, (key, value) => (key === 'position' ? undefined : value)),
    );
    console.log(
      'DIAGNOSTIC_TREE_AFTER_REHYPE_RAW=' +
        JSON.stringify(hastTree, (key, value) => (key === 'position' ? undefined : value), 2),
    );
  });
});

describe('markdownSanitizeSchema', () => {
  it('renders a representative safe SVG intact (shapes, gradient, internal use/defs/symbol reference) [unit]', () => {
    const svg =
      '<svg viewBox="0 0 100 100"><defs><linearGradient id="g1"><stop offset="0%" stop-color="#fff"/></linearGradient><symbol id="dot"><circle cx="5" cy="5" r="5"/></symbol></defs><use href="#dot" x="10" y="10"/><rect x="0" y="0" width="20" height="20" fill="#000"/></svg>';
    const out = render(svg).toLowerCase();

    expect(out).toContain('<svg');
    expect(out).toContain('<use');
    expect(out).toContain('href="#dot"');
    expect(out).toContain('<circle');
    expect(out).toContain('<rect');
  });

  it('strips <script>, even nested inside an svg [unit]', () => {
    const out = render('<svg><script>alert(1)</script></svg>').toLowerCase();
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips <iframe> [unit]', () => {
    const out = render('<svg><iframe src="https://evil.example"></iframe></svg>').toLowerCase();
    expect(out).not.toContain('<iframe');
  });

  it('strips on* event handler attributes [unit]', () => {
    const out = render('<svg><rect onclick="alert(1)" width="1" height="1"/></svg>').toLowerCase();
    expect(out).not.toContain('onclick');
  });

  it('strips a javascript: href on use [unit]', () => {
    const out = render('<svg><use href="javascript:alert(1)"/></svg>').toLowerCase();
    expect(out).not.toContain('javascript:');
  });

  it('strips foreignObject, the standard sanitizer-bypass for smuggling HTML through SVG [unit]', () => {
    const out = render('<svg><foreignObject><div>x</div></foreignObject></svg>').toLowerCase();
    expect(out).not.toContain('foreignobject');
    expect(out).not.toContain('<div');
  });

  it('strips <image> entirely — no internal-only use case, same external-fetch risk as an absolute-URL use [unit]', () => {
    const out = render('<svg><image href="https://evil.example/pixel.png"/></svg>').toLowerCase();
    expect(out).not.toContain('<image');
  });

  it('strips an absolute-URL href on use (tracking-pixel/read-receipt vector) [unit]', () => {
    const out = render('<svg><use href="https://evil.example/#x"/></svg>').toLowerCase();
    expect(out).not.toContain('evil.example');
  });

  it('strips an absolute-URL href on an animation element [unit]', () => {
    const out = render('<svg><animate href="https://evil.example/#x" /></svg>').toLowerCase();
    expect(out).not.toContain('evil.example');
  });

  it('allows an animation element with local-ref href and value attributes [unit]', () => {
    const out = render(
      '<svg><circle id="c1" cx="5" cy="5" r="5"/><animate href="#c1" attributeName="r" dur="2s" repeatCount="indefinite" from="5" to="10"/></svg>',
    ).toLowerCase();
    expect(out).toContain('<animate');
    expect(out).toContain('attributename="r"');
    expect(out).toContain('repeatcount="indefinite"');
  });

  it('strips a top-level <style> with no svg ancestor [unit]', () => {
    const out = render('<style>body{display:none}</style>text').toLowerCase();
    expect(out).not.toContain('<style');
  });

  it('allows <style> only when nested inside an svg [unit]', () => {
    const out = render(
      '<svg><style>circle{fill:red}</style><circle cx="1" cy="1" r="1"/></svg>',
    ).toLowerCase();
    expect(out).toContain('<style');
  });

  it('strips an orphan SVG child element with no svg ancestor [unit]', () => {
    const out = render('<path d="M0 0 L10 10"/>').toLowerCase();
    expect(out).not.toContain('<path');
  });

  it('keeps an external href on a plain Markdown link, inside or outside SVG [unit]', () => {
    expect(render('[link](https://example.com)')).toContain('href="https://example.com"');
    const out = render('<svg><a href="https://example.com">x</a></svg>');
    expect(out).toContain('href="https://example.com"');
  });

  it('leaves existing non-SVG Markdown unaffected (headings, GFM table, task list) [unit]', () => {
    const md = '# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo';
    const out = render(md).toLowerCase();
    expect(out).toContain('<h1>title</h1>');
    expect(out).toContain('<table>');
    expect(out).toContain('type="checkbox"');
  });
});
