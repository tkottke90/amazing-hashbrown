import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { z } from 'zod';
import {
  mcpToolToLangChain,
  invalidateChatAgent,
  invalidateWorkspaceChatAgent,
  buildWikiWriteTools,
  buildTaskContextBlock,
} from './chat-agent.js';
import type { RegisteredTool } from '@tkottke90/tools-manager';
import { makeMcpTool } from '@/tests/fixtures/registered-tool.fixture.js';

describe('agents/chat-agent', () => {
  describe('mcpToolToLangChain()', () => {
    it('preserves the tool name', () => {
      const lc = mcpToolToLangChain(makeMcpTool({ name: 'my_tool' }));
      expect(lc.name).to.equal('my_tool');
    });

    it('preserves the tool description', () => {
      const lc = mcpToolToLangChain(makeMcpTool({ description: 'does something useful' }));
      expect(lc.description).to.equal('does something useful');
    });

    it('passes string results through unchanged', async () => {
      const lc = mcpToolToLangChain(makeMcpTool({ execute: async () => 'hello from mcp' }));
      const result = await lc.invoke({});
      expect(result).to.equal('hello from mcp');
    });

    it('JSON-stringifies object results', async () => {
      const payload = { status: 'ok', count: 3 };
      const lc = mcpToolToLangChain(makeMcpTool({ execute: async () => payload }));
      const result = await lc.invoke({});
      expect(result).to.equal(JSON.stringify(payload));
    });

    it('JSON-stringifies array results', async () => {
      const payload = [1, 2, 3];
      const lc = mcpToolToLangChain(makeMcpTool({ execute: async () => payload }));
      const result = await lc.invoke({});
      expect(result).to.equal(JSON.stringify(payload));
    });

    it('passes the invocation arguments through to execute', async () => {
      let captured: Record<string, unknown> = {};
      const lc = mcpToolToLangChain(
        makeMcpTool({
          parameters: z.object({ x: z.string() }) as unknown as RegisteredTool['parameters'],
          execute: async (args) => {
            captured = args;
            return 'ok';
          },
        }),
      );
      await lc.invoke({ x: 'hello' });
      expect(captured).to.deep.equal({ x: 'hello' });
    });
  });

  describe('invalidateChatAgent()', () => {
    beforeEach(() => {
      // Ensure no cached agent from a previous test leaks into this suite
      invalidateChatAgent();
    });

    it('does not throw when no agent is cached', () => {
      expect(() => invalidateChatAgent()).to.not.throw();
    });

    it('can be called multiple times without error', () => {
      invalidateChatAgent();
      invalidateChatAgent();
      invalidateChatAgent();
    });
  });

  describe('invalidateWorkspaceChatAgent()', () => {
    it('does not throw when no workspace agent is cached', () => {
      expect(() => invalidateWorkspaceChatAgent('no-such-workspace')).to.not.throw();
    });

    it('can be called multiple times without error', () => {
      invalidateWorkspaceChatAgent('ws-1');
      invalidateWorkspaceChatAgent('ws-1');
      invalidateWorkspaceChatAgent('ws-2');
    });
  });

  describe('buildWikiWriteTools()', () => {
    const expectedNames = [
      'wiki_create_page',
      'wiki_update_page',
      'wiki_add_cross_link',
      'wiki_rebaseline_source',
    ];

    it('returns the four write-capable wiki tools, unrestricted, when called with no argument', () => {
      const tools = buildWikiWriteTools();
      expect(tools.map((t) => t.name)).to.have.members(expectedNames);
    });

    it('returns the same four tool names when scoped to a project wiki', () => {
      const tools = buildWikiWriteTools('proj-wiki');
      expect(tools.map((t) => t.name)).to.have.members(expectedNames);
    });

    it('builds a fresh set of tool instances on each call, not a shared singleton', () => {
      const a = buildWikiWriteTools('wiki-a');
      const b = buildWikiWriteTools('wiki-b');
      expect(a[0]).to.not.equal(b[0]);
    });
  });

  describe('buildTaskContextBlock()', () => {
    it('always states the task title and the complete_task/ask_user instruction', () => {
      const block = buildTaskContextBlock({
        title: 'Summarize the inbox',
        description: null,
        outcome: null,
      });
      expect(block).to.include('"Summarize the inbox"');
      expect(block).to.include('complete_task');
      expect(block).to.include('ask_user');
    });

    it('includes the description when present', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: 'Read every unread email and summarize it.',
        outcome: null,
      });
      expect(block).to.include('Read every unread email and summarize it.');
    });

    it('omits a description line when absent', () => {
      const block = buildTaskContextBlock({ title: 'T', description: null, outcome: null });
      expect(block).to.not.include('Description:');
    });

    it('includes the outcome when present', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: null,
        outcome: 'A markdown summary page exists in the wiki.',
      });
      expect(block).to.include('A markdown summary page exists in the wiki.');
    });

    it('omits an outcome line when absent', () => {
      const block = buildTaskContextBlock({ title: 'T', description: null, outcome: null });
      expect(block).to.not.include('Outcome to reach:');
    });
  });
});
