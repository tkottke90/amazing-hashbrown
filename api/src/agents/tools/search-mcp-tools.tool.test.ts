import { describe, it } from 'mocha';
import { expect } from 'chai';
import { makeSearchMcpToolsTool } from './search-mcp-tools.tool.js';
import type { DiscoverableMcpTool } from '../tool-config.js';

const CATALOG: DiscoverableMcpTool[] = [
  { toolId: 'n8n:workflow_search', name: 'workflow_search', description: 'Search workflows' },
  { toolId: 'n8n:workflow_get', name: 'workflow_get', description: 'Get a workflow by id' },
  { toolId: 'playwright:browser_click', name: 'browser_click', description: 'Click an element' },
];

describe('agents/tools/search-mcp-tools.tool', () => {
  it('returns every catalog entry when no keyword is given', async () => {
    const tool = makeSearchMcpToolsTool(() => CATALOG);
    const result = JSON.parse(String(await tool.invoke({})));
    expect(result).to.have.lengthOf(3);
  });

  it('matches case-insensitively against the tool id', async () => {
    const tool = makeSearchMcpToolsTool(() => CATALOG);
    const result = JSON.parse(String(await tool.invoke({ keyword: 'N8N' })));
    expect(result.map((t: DiscoverableMcpTool) => t.toolId)).to.deep.equal([
      'n8n:workflow_search',
      'n8n:workflow_get',
    ]);
  });

  it('matches case-insensitively against the name', async () => {
    const tool = makeSearchMcpToolsTool(() => CATALOG);
    const result = JSON.parse(String(await tool.invoke({ keyword: 'BROWSER_CLICK' })));
    expect(result).to.have.lengthOf(1);
    expect(result[0].toolId).to.equal('playwright:browser_click');
  });

  it('matches case-insensitively against the description', async () => {
    const tool = makeSearchMcpToolsTool(() => CATALOG);
    const result = JSON.parse(String(await tool.invoke({ keyword: 'click an element' })));
    expect(result).to.have.lengthOf(1);
    expect(result[0].toolId).to.equal('playwright:browser_click');
  });

  it('returns a plain "no match" message, never JSON, when a keyword matches nothing', async () => {
    const tool = makeSearchMcpToolsTool(() => CATALOG);
    expect(await tool.invoke({ keyword: 'zzz' })).to.equal('No MCP tools found matching "zzz".');
  });

  it('returns a plain "none available" message when the catalog itself is empty', async () => {
    const tool = makeSearchMcpToolsTool(() => []);
    expect(await tool.invoke({})).to.equal('No MCP tools are available.');
  });

  it('never exposes a bound name (boundName) field — only toolId/name/description', async () => {
    const tool = makeSearchMcpToolsTool(() => CATALOG);
    const result = JSON.parse(String(await tool.invoke({})));
    for (const entry of result) {
      expect(Object.keys(entry).sort()).to.deep.equal(['description', 'name', 'toolId']);
    }
  });

  it('resolves the catalog fresh on every call, not once at build time', async () => {
    let current = CATALOG;
    const tool = makeSearchMcpToolsTool(() => current);
    expect(JSON.parse(String(await tool.invoke({})))).to.have.lengthOf(3);
    current = [];
    expect(await tool.invoke({})).to.equal('No MCP tools are available.');
  });
});
