import { expect } from 'chai';
import {
  extractWikilinks,
  normalizeLink,
  resolveLinkTarget,
  outboundLinkCount,
} from '../src/internal/wikilinks.js';
import { extractBody, sha256Body } from '../src/internal/sha.js';
import { slugify, pagePathFor, suggestRawPath } from '../src/internal/paths.js';
import {
  upsertIndexEntry,
  setIndexMeta,
  formatLogEntry,
  countLogEntries,
  parseRecentLog,
} from '../src/internal/nav.js';

describe('wikilinks', () => {
  it('extracts and normalizes links', () => {
    expect(extractWikilinks('see [[foo]] and [[bar|Bar]]')).to.deep.equal(['foo', 'bar|Bar']);
    expect(normalizeLink('bar|Bar')).to.equal('bar');
    expect(normalizeLink('baz.md')).to.equal('baz');
  });

  it('resolves by stem then basename', () => {
    const pages = ['entities/foo.md', 'concepts/bar.md'];
    expect(resolveLinkTarget('entities/foo', pages)).to.equal('entities/foo.md');
    expect(resolveLinkTarget('bar', pages)).to.equal('concepts/bar.md');
    expect(resolveLinkTarget('missing', pages)).to.equal(null);
  });

  it('counts distinct resolvable outbound links, excluding self', () => {
    const pages = ['entities/a.md', 'entities/b.md', 'entities/c.md'];
    const body = 'links to [[b]] and [[c]] and [[a]] and [[nope]]';
    expect(outboundLinkCount(body, pages, 'entities/a.md')).to.equal(2);
  });
});

describe('sha', () => {
  it('hashes body only, ignoring frontmatter changes', () => {
    const a = '---\ntitle: A\n---\nsame body';
    const b = '---\ntitle: B\nupdated: 2026-01-02\n---\nsame body';
    expect(sha256Body(a)).to.equal(sha256Body(b));
  });

  it('extractBody drops the frontmatter block', () => {
    expect(extractBody('---\nx: 1\n---\nhello').trim()).to.equal('hello');
    expect(extractBody('no fm')).to.equal('no fm');
  });
});

describe('paths', () => {
  it('slugifies titles', () => {
    expect(slugify('Hello, World! 123')).to.equal('hello-world-123');
  });

  it('derives page paths by type', () => {
    expect(pagePathFor('entity', 'My Host')).to.equal('entities/my-host.md');
    expect(pagePathFor('concept', 'Some Idea')).to.equal('concepts/some-idea.md');
    expect(pagePathFor('comparison', 'A vs B')).to.equal('comparisons/a-vs-b.md');
  });

  it('suggests raw paths for files and urls', () => {
    expect(suggestRawPath({ filename: '/tmp/My Note.md', today: '2026-07-04' })).to.equal(
      'raw/articles/my-note.md',
    );
    expect(suggestRawPath({ url: 'https://example.com/a', today: '2026-07-04' })).to.equal(
      'raw/articles/example-com-a-2026-07-04.md',
    );
  });
});

describe('nav/index', () => {
  const base =
    '# Wiki Index\n\n> Last updated: 2026-01-01 | Total pages: 0\n\n## Entities\n\n## Concepts\n';

  it('inserts an entry under the right section', () => {
    const out = upsertIndexEntry(base, {
      type: 'entity',
      stem: 'entities/foo',
      title: 'Foo',
      summary: 'a foo',
    });
    expect(out).to.include('## Entities\n- [[entities/foo|Foo]] — a foo');
  });

  it('does not duplicate an existing entry', () => {
    const once = upsertIndexEntry(base, {
      type: 'entity',
      stem: 'entities/foo',
      title: 'Foo',
      summary: 'a foo',
    });
    const twice = upsertIndexEntry(once, {
      type: 'entity',
      stem: 'entities/foo',
      title: 'Foo',
      summary: 'a foo',
    });
    expect(twice).to.equal(once);
  });

  it('updates the meta line', () => {
    const out = setIndexMeta(base, { today: '2026-07-04', totalPages: 5 });
    expect(out).to.include('> Last updated: 2026-07-04 | Total pages: 5');
  });
});

describe('nav/log', () => {
  it('formats entries with and without files', () => {
    expect(formatLogEntry({ today: '2026-07-04', action: 'query', subject: 'x' })).to.equal(
      '## [2026-07-04] query | x\n',
    );
    const withFiles = formatLogEntry({
      today: '2026-07-04',
      action: 'ingest',
      subject: 'Src',
      files: ['entities/a.md'],
    });
    expect(withFiles).to.include('- entities/a.md');
  });

  it('counts and parses recent entries', () => {
    const log = [
      '# Wiki Log',
      '## [2026-01-01] create | init',
      '## [2026-01-02] ingest | Article A',
      '## [2026-01-03] query | question',
    ].join('\n');
    expect(countLogEntries(log)).to.equal(3);
    const recent = parseRecentLog(log, 2);
    expect(recent).to.have.length(2);
    expect(recent[0]?.action).to.equal('ingest');
    expect(recent[1]?.subject).to.equal('question');
  });
});
