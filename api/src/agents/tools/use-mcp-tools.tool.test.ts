import { describe, it } from 'mocha';
import { expect } from 'chai';
import { makeUseMcpToolsTool, type UseMcpToolsResult } from './use-mcp-tools.tool.js';

const ROWS = [
  { toolId: 'n8n:workflow_search', enabled: true },
  { toolId: 'n8n:workflow_get', enabled: true },
  { toolId: 'n8n:workflow_delete', enabled: false },
];

describe('agents/tools/use-mcp-tools.tool', () => {
  it('accepts an enabled, existing tool id', async () => {
    const tool = makeUseMcpToolsTool(() => ROWS);
    const result: UseMcpToolsResult = JSON.parse(
      String(await tool.invoke({ toolIds: ['n8n:workflow_search'] })),
    );
    expect(result).to.deep.equal({ accepted: ['n8n:workflow_search'], rejected: [] });
  });

  it('rejects an id with no matching MCP tool row as not_found', async () => {
    const tool = makeUseMcpToolsTool(() => ROWS);
    const result: UseMcpToolsResult = JSON.parse(
      String(await tool.invoke({ toolIds: ['not_a_real_tool'] })),
    );
    expect(result).to.deep.equal({
      accepted: [],
      rejected: [{ toolId: 'not_a_real_tool', reason: 'not_found' }],
    });
  });

  it('rejects a real but disabled tool id as disabled', async () => {
    const tool = makeUseMcpToolsTool(() => ROWS);
    const result: UseMcpToolsResult = JSON.parse(
      String(await tool.invoke({ toolIds: ['n8n:workflow_delete'] })),
    );
    expect(result).to.deep.equal({
      accepted: [],
      rejected: [{ toolId: 'n8n:workflow_delete', reason: 'disabled' }],
    });
  });

  it('partitions a mix of accepted, not_found, and disabled ids in one call', async () => {
    const tool = makeUseMcpToolsTool(() => ROWS);
    const result: UseMcpToolsResult = JSON.parse(
      String(
        await tool.invoke({
          toolIds: ['n8n:workflow_search', 'not_a_real_tool', 'n8n:workflow_delete'],
        }),
      ),
    );
    expect(result.accepted).to.deep.equal(['n8n:workflow_search']);
    expect(result.rejected).to.have.deep.members([
      { toolId: 'not_a_real_tool', reason: 'not_found' },
      { toolId: 'n8n:workflow_delete', reason: 'disabled' },
    ]);
  });

  it('returns both arrays empty for an empty toolIds input', async () => {
    const tool = makeUseMcpToolsTool(() => ROWS);
    const result: UseMcpToolsResult = JSON.parse(String(await tool.invoke({ toolIds: [] })));
    expect(result).to.deep.equal({ accepted: [], rejected: [] });
  });

  it('resolves the catalog rows fresh on every call, not once at build time', async () => {
    let current = ROWS;
    const tool = makeUseMcpToolsTool(() => current);
    expect(
      JSON.parse(String(await tool.invoke({ toolIds: ['n8n:workflow_search'] }))).accepted,
    ).to.deep.equal(['n8n:workflow_search']);
    current = [];
    expect(
      JSON.parse(String(await tool.invoke({ toolIds: ['n8n:workflow_search'] }))).rejected,
    ).to.deep.equal([{ toolId: 'n8n:workflow_search', reason: 'not_found' }]);
  });
});
