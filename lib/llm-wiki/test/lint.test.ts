import { expect } from 'chai';
import { runLint, type LintContext, type LintPage } from '../src/internal/lint/index.js';
import type { LintCheckId } from '../src/types.js';

function page(relPath: string, frontmatter: Record<string, unknown>, content: string): LintPage {
  return {
    relPath,
    frontmatter,
    body: content,
    content,
    lineCount: content.split('\n').length,
  };
}

function baseContext(pages: LintPage[], overrides: Partial<LintContext> = {}): LintContext {
  return {
    pages,
    indexContent: pages.map((p) => `- [[${p.relPath.replace(/\.md$/, '')}]]`).join('\n'),
    logEntryCount: 0,
    taxonomy: new Set(['host', 'service']),
    rawFiles: [],
    today: '2026-07-04',
    ...overrides,
  };
}

const goodFm = {
  title: 'Foo',
  created: '2026-07-01',
  updated: '2026-07-01',
  type: 'entity',
  tags: ['host'],
  sources: ['raw/x.md'],
};

function findingIds(checks: { check: LintCheckId }[]): LintCheckId[] {
  return checks.map((c) => c.check);
}

describe('lint/runLint', () => {
  it('flags broken links as errors and marks the report not ok', () => {
    const pages = [page('entities/a.md', goodFm, 'links to [[nonexistent]]')];
    const report = runLint(baseContext(pages), { only: ['broken_links'] });
    expect(report.ok).to.equal(false);
    expect(report.checks[0]?.severity).to.equal('error');
  });

  it('flags orphans (no inbound links)', () => {
    const pages = [
      page('entities/a.md', goodFm, 'standalone'),
      page('entities/b.md', goodFm, 'no links either'),
    ];
    const report = runLint(baseContext(pages), { only: ['orphans'] });
    expect(findingIds(report.checks)).to.deep.equal(['orphans', 'orphans']);
  });

  it('flags missing required frontmatter as an error', () => {
    const pages = [page('entities/a.md', { title: 'A' }, 'body')];
    const report = runLint(baseContext(pages), { only: ['frontmatter'] });
    expect(report.ok).to.equal(false);
  });

  it('flags tags outside the taxonomy', () => {
    const pages = [page('entities/a.md', { ...goodFm, tags: ['bogus'] }, 'body')];
    const report = runLint(baseContext(pages), { only: ['tag_audit'] });
    expect(report.checks).to.have.length(1);
    expect(report.checks[0]?.message).to.contain('bogus');
  });

  it('flags source drift on sha mismatch', () => {
    const ctx = baseContext([], {
      rawFiles: [{ relPath: 'raw/a.md', storedSha: 'aaa', actualSha: 'bbb' }],
    });
    const report = runLint(ctx, { only: ['source_drift'] });
    expect(report.checks).to.have.length(1);
    expect(report.ok).to.equal(true); // warn severity, not error
  });

  it('flags stale pages beyond 90 days', () => {
    const pages = [page('entities/a.md', { ...goodFm, updated: '2026-01-01' }, 'body')];
    const report = runLint(baseContext(pages), { only: ['stale'] });
    expect(report.checks[0]?.check).to.equal('stale');
  });

  it('flags index gaps', () => {
    const ctx = baseContext([page('entities/a.md', goodFm, 'body')], { indexContent: '# Empty' });
    const report = runLint(ctx, { only: ['index'] });
    expect(report.checks).to.have.length(1);
  });

  it('runs registry_sync only when registry data is present', () => {
    const noData = runLint(baseContext([]), { only: ['registry_sync'] });
    expect(noData.checks).to.have.length(0);
    const withData = runLint(
      baseContext([], { registryWikiIds: ['known'], onDiskWikiDirs: ['known', 'stray'] }),
      { only: ['registry_sync'] },
    );
    expect(withData.checks).to.have.length(1);
    expect(withData.checks[0]?.message).to.contain('stray');
  });
});
