import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { z } from 'zod';
import { mcpToolToLangChain, invalidateChatAgent } from './chat-agent.js';
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
});
