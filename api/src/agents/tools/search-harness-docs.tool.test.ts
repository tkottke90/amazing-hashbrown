import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { LlmWiki } from '@tkottke90/llm-wiki';
import { makeSearchHarnessDocsTool } from './search-harness-docs.tool.js';

enum TestTypes {
  UNIT = '[unit]',
}

describe('agents/tools/search-harness-docs', () => {
  let dir: string;
  let wiki: LlmWiki;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'search-harness-docs-tool-test-'));
    wiki = await LlmWiki.create({ path: dir, name: 'Harness Docs', domain: 'test' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(`returns the matching page's content for a query that matches a committed page ${TestTypes.UNIT}`, async () => {
    await wiki.commitPage({
      type: 'concept',
      title: 'Widget',
      tags: ['Dashboard Widgets'],
      sources: [],
      body: 'One self-contained unit of dashboard content, persisted as its own file.',
    });

    const tool = makeSearchHarnessDocsTool(async () => wiki);
    const result = await tool.invoke({ query: 'What is a Widget?' });

    expect(result).to.include('Widget');
    expect(result).to.include('One self-contained unit of dashboard content');
  });

  it(`returns a plain "not found" string when no page matches, rather than an empty or thrown result ${TestTypes.UNIT}`, async () => {
    const tool = makeSearchHarnessDocsTool(async () => wiki);
    const result = await tool.invoke({ query: 'completely unrelated nonsense query' });

    expect(result).to.equal(
      'No harness documentation found matching "completely unrelated nonsense query".',
    );
  });

  it(`stops accumulating results before the combined response would exceed its budget, rather than returning everything ${TestTypes.UNIT}`, async () => {
    // Three pages, each ~3,500 chars: two together (~7,000) fit under the
    // 8,000-char budget, a third would push it over.
    const bodyOf = (label: string) => `${label} `.repeat(500); // ~3,500+ chars incl. label
    for (const label of ['alpha', 'beta', 'gamma']) {
      await wiki.commitPage({
        type: 'concept',
        title: `Term ${label}`,
        tags: [],
        sources: [],
        body: `budget-test-query shared keyword. ${bodyOf(label)}`,
      });
    }

    const tool = makeSearchHarnessDocsTool(async () => wiki);
    const result = await tool.invoke({ query: 'budget-test-query' });

    expect(result.length).to.be.at.most(8_000 + 200); // + small header/formatting slack
    const includedCount = ['alpha', 'beta', 'gamma'].filter((l) =>
      result.includes(`Term ${l}`),
    ).length;
    expect(includedCount).to.be.lessThan(3);
    expect(includedCount).to.be.greaterThan(0);
  });

  it(`returns a plain error string rather than throwing when the wiki loader itself fails ${TestTypes.UNIT}`, async () => {
    const tool = makeSearchHarnessDocsTool(async () => {
      throw new Error('boom');
    });

    const result = await tool.invoke({ query: 'anything' });

    expect(result).to.include('search_harness_docs failed');
    expect(result).to.include('boom');
  });
});
