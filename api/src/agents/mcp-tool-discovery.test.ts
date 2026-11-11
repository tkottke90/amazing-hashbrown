import { describe, it } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { computeDiscoveredToolIds } from './mcp-tool-discovery.js';

function useMcpToolsCall(toolCallId: string, toolIds: string[]) {
  return new AIMessage({
    content: '',
    tool_calls: [{ id: toolCallId, name: 'use_mcp_tools', args: { toolIds } }],
  });
}

function useMcpToolsResult(toolCallId: string, accepted: string[], rejected: unknown[] = []) {
  return new ToolMessage({
    content: JSON.stringify({ accepted, rejected }),
    tool_call_id: toolCallId,
    name: 'use_mcp_tools',
  });
}

describe('agents/mcp-tool-discovery', () => {
  describe('computeDiscoveredToolIds()', () => {
    it('returns an empty set for no messages', () => {
      expect(computeDiscoveredToolIds([])).to.deep.equal(new Set());
    });

    it('returns an empty set when nothing in the turn called use_mcp_tools', () => {
      const messages = [new HumanMessage('hello'), new AIMessage('hi there')];
      expect(computeDiscoveredToolIds(messages)).to.deep.equal(new Set());
    });

    it('collects the accepted ids from a single use_mcp_tools call this turn', () => {
      const messages = [
        new HumanMessage('use the n8n search tool'),
        useMcpToolsCall('c1', ['n8n:workflow_search']),
        useMcpToolsResult('c1', ['n8n:workflow_search']),
      ];
      expect(computeDiscoveredToolIds(messages)).to.deep.equal(new Set(['n8n:workflow_search']));
    });

    it('unions accepted ids across two use_mcp_tools calls in the same turn', () => {
      const messages = [
        new HumanMessage('do the thing'),
        useMcpToolsCall('c1', ['n8n:workflow_search']),
        useMcpToolsResult('c1', ['n8n:workflow_search']),
        new AIMessage('also need another one'),
        useMcpToolsCall('c2', ['n8n:workflow_get']),
        useMcpToolsResult('c2', ['n8n:workflow_get']),
      ];
      expect(computeDiscoveredToolIds(messages)).to.deep.equal(
        new Set(['n8n:workflow_search', 'n8n:workflow_get']),
      );
    });

    it('does not carry a grant forward from a previous turn', () => {
      const messages = [
        new HumanMessage('turn one'),
        useMcpToolsCall('c1', ['n8n:workflow_search']),
        useMcpToolsResult('c1', ['n8n:workflow_search']),
        new AIMessage('done with turn one'),
        new HumanMessage('turn two — unrelated'),
        new AIMessage('ok'),
      ];
      expect(computeDiscoveredToolIds(messages)).to.deep.equal(new Set());
    });

    it('ignores a rejected id — only accepted ids are discovered', () => {
      const messages = [
        new HumanMessage('try a couple'),
        useMcpToolsCall('c1', ['n8n:workflow_search', 'not_a_real_tool']),
        useMcpToolsResult(
          'c1',
          ['n8n:workflow_search'],
          [{ toolId: 'not_a_real_tool', reason: 'not_found' }],
        ),
      ];
      expect(computeDiscoveredToolIds(messages)).to.deep.equal(new Set(['n8n:workflow_search']));
    });

    it('does not throw on malformed/non-JSON tool message content, and contributes nothing', () => {
      const messages = [
        new HumanMessage('turn'),
        new ToolMessage({
          content: 'not json at all',
          tool_call_id: 'c1',
          name: 'use_mcp_tools',
        }),
      ];
      expect(() => computeDiscoveredToolIds(messages)).to.not.throw();
      expect(computeDiscoveredToolIds(messages)).to.deep.equal(new Set());
    });

    it('ignores a ToolMessage from an unrelated tool', () => {
      const messages = [
        new HumanMessage('turn'),
        new ToolMessage({
          content: JSON.stringify({ accepted: ['should_not_appear'] }),
          tool_call_id: 'c1',
          name: 'some_other_tool',
        }),
      ];
      expect(computeDiscoveredToolIds(messages)).to.deep.equal(new Set());
    });
  });
});
