import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { z } from 'zod';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import {
  mcpToolToLangChain,
  invalidateChatAgent,
  invalidateWorkspaceChatAgent,
  buildWikiWriteTools,
  buildTaskContextBlock,
  estimateToolsTokens,
  createContextWindowMiddleware,
} from './chat-agent.js';
import { logger } from '../config/logger.js';
import type { RegisteredTool } from '@tkottke90/tools-manager';
import { makeMcpTool } from '@/tests/fixtures/registered-tool.fixture.js';

// Monkey-patches one logger method to record calls while forwarding to the
// real implementation — no mocking library needed (this repo uses mocha +
// chai only). Mirrors the identical helper in after-agent.test.ts. Always
// call restore() in a finally block.
function captureLogCalls(method: 'warn' | 'debug') {
  const spy = logger as unknown as Record<string, (msg: string, meta?: unknown) => void>;
  const original = spy[method].bind(logger);
  const calls: Array<{ message: string; meta: unknown }> = [];
  spy[method] = (message: string, meta?: unknown) => {
    calls.push({ message, meta });
    original(message, meta);
  };
  return {
    calls,
    restore: () => {
      spy[method] = original;
    },
  };
}

// A real StructuredTool (via tool()) with a Zod schema and a description of
// a controllable size — mirrors how every tool this app actually binds is
// built (e.g. wiki-search.tool.ts's WikiSearchSchema), so estimateToolsTokens
// exercises the real toJsonSchema conversion path, not a hand-rolled stand-in.
function makeFakeTool(name: string, descriptionLength = 20) {
  return tool(async () => 'ok', {
    name,
    description: 'x'.repeat(descriptionLength),
    schema: z.object({ query: z.string().describe('a query parameter') }),
  });
}

// A tool whose .schema throws on any property access, forcing
// estimateToolsTokens' per-tool try/catch fallback path regardless of which
// internal probe toJsonSchema happens to use to detect a schema's shape.
function makePoisonTool(name: string) {
  return {
    name,
    description: 'poison',
    schema: new Proxy(
      {},
      {
        get(): never {
          throw new Error('schema access boom');
        },
      },
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

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

  describe('estimateToolsTokens()', () => {
    it('returns 0 for an empty tool list', () => {
      expect(estimateToolsTokens([])).to.equal(0);
    });

    it('scales up with a larger description/schema payload', () => {
      const small = estimateToolsTokens([makeFakeTool('small_tool', 10)]);
      const large = estimateToolsTokens([makeFakeTool('large_tool', 500)]);
      expect(large).to.be.greaterThan(small);
    });

    it('sums per-tool estimates across multiple tools', () => {
      const one = estimateToolsTokens([makeFakeTool('t1', 100)]);
      const two = estimateToolsTokens([makeFakeTool('t1', 100), makeFakeTool('t2', 100)]);
      expect(two).to.be.greaterThan(one);
    });

    it('falls back to name+description and logs a warning when schema conversion throws', () => {
      const log = captureLogCalls('warn');
      try {
        const result = estimateToolsTokens([makePoisonTool('cursed_tool')]);
        expect(result).to.be.greaterThan(0);
        expect(log.calls).to.have.length.greaterThan(0);
        expect(log.calls[0]!.message).to.include('tool schema estimate failed');
      } finally {
        log.restore();
      }
    });
  });

  describe('createContextWindowMiddleware()', () => {
    function fakeRequest(tools: unknown[], messages: unknown[], systemMessage: unknown) {
      return {
        tools,
        messages,
        systemMessage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }

    // Long enough that its message-only token estimate comfortably clears
    // MIN_BUDGET_FLOOR (2000), so trimming triggered by tool overhead below
    // is distinguishable from the separate floor-clamping test.
    function makeLongMessageHistory(count = 100) {
      return Array.from({ length: count }, (_, i) =>
        i % 2 === 0
          ? new HumanMessage(`question number ${i}: `.repeat(10))
          : new AIMessage(`answer number ${i}: `.repeat(10)),
      );
    }

    const systemMessage = new SystemMessage('You are a helpful assistant.');

    describe('wrapModelCall', () => {
      it('does not trim when no tools are bound and messages alone fit under maxTokens', async () => {
        const messages = makeLongMessageHistory();
        const middleware = createContextWindowMiddleware({
          enabled: true,
          maxTokens: 1_000_000,
          safetyMarginPct: 0.85,
        });

        let seenMessages: unknown[] = [];
        const handler = async (req: { messages: unknown[] }) => {
          seenMessages = req.messages;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return {} as any;
        };

        await middleware.wrapModelCall!(fakeRequest([], messages, systemMessage), handler);

        expect(seenMessages.length).to.equal(messages.length);
      });

      it('trims once tool-schema overhead is counted for the same maxTokens/messages (regression test for #127)', async () => {
        const messages = makeLongMessageHistory();
        const bigTools = Array.from({ length: 15 }, (_, i) => makeFakeTool(`tool_${i}`, 500));
        const toolsTokens = estimateToolsTokens(bigTools);

        // Ceiling sits comfortably above the tool overhead alone (so this
        // isn't the MIN_BUDGET_FLOOR case) but the remaining message budget
        // is deliberately small relative to the full 100-message history.
        const maxTokens = Math.ceil((toolsTokens + 2500) / 0.85);
        const middleware = createContextWindowMiddleware({
          enabled: true,
          maxTokens,
          safetyMarginPct: 0.85,
        });

        let seenMessages: unknown[] = [];
        const handler = async (req: { messages: unknown[] }) => {
          seenMessages = req.messages;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return {} as any;
        };

        await middleware.wrapModelCall!(fakeRequest(bigTools, messages, systemMessage), handler);

        expect(seenMessages.length).to.be.lessThan(messages.length);
        expect(seenMessages.length).to.be.greaterThan(0);
      });

      it('floors the budget at MIN_BUDGET_FLOOR and logs a warning when tool overhead alone exceeds the ceiling', async () => {
        const messages = makeLongMessageHistory();
        const bigTools = Array.from({ length: 15 }, (_, i) => makeFakeTool(`tool_${i}`, 500));
        const middleware = createContextWindowMiddleware({
          enabled: true,
          maxTokens: 100,
          safetyMarginPct: 0.85,
        });

        let seenMessages: unknown[] = [];
        const handler = async (req: { messages: unknown[] }) => {
          seenMessages = req.messages;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return {} as any;
        };

        const log = captureLogCalls('warn');
        try {
          await middleware.wrapModelCall!(fakeRequest(bigTools, messages, systemMessage), handler);

          expect(seenMessages.length).to.be.lessThan(messages.length);
          expect(log.calls).to.have.length.greaterThan(0);
          expect(log.calls[0]!.message).to.include('budget floored');
        } finally {
          log.restore();
        }
      });

      it('passes the request through unmodified when disabled', async () => {
        const messages = makeLongMessageHistory();
        const bigTools = Array.from({ length: 15 }, (_, i) => makeFakeTool(`tool_${i}`, 500));
        const middleware = createContextWindowMiddleware({
          enabled: false,
          maxTokens: 100,
          safetyMarginPct: 0.85,
        });

        let seenMessages: unknown[] = [];
        const handler = async (req: { messages: unknown[] }) => {
          seenMessages = req.messages;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return {} as any;
        };

        await middleware.wrapModelCall!(fakeRequest(bigTools, messages, systemMessage), handler);

        expect(seenMessages.length).to.equal(messages.length);
      });
    });
  });
});
