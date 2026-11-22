import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { createAgent } from 'langchain';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command, GraphInterrupt } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../config/logger.js';
import { createToolErrorRecoveryMiddleware } from './tool-error-recovery.middleware.js';

function fakeToolCallRequest(args: Record<string, unknown>, name = 'flaky_tool') {
  return {
    toolCall: { id: 'call-1', name, args },
    tool: undefined,
    state: { messages: [] },
    runtime: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('agents/tool-error-recovery.middleware', () => {
  let warnCalls: unknown[][];
  let originalWarn: typeof logger.warn;

  beforeEach(() => {
    warnCalls = [];
    originalWarn = logger.warn;
    logger.warn = ((...args: unknown[]) => {
      warnCalls.push(args);
    }) as typeof logger.warn;
  });

  afterEach(() => {
    logger.warn = originalWarn;
  });

  describe('wrapToolCall [unit]', () => {
    it('converts a thrown plain Error into an error ToolMessage, and warns', async () => {
      const middleware = createToolErrorRecoveryMiddleware();
      const handler = async () => {
        throw new Error('boom');
      };

      const result = await middleware.wrapToolCall!(fakeToolCallRequest({}), handler);

      expect(result).to.be.instanceOf(ToolMessage);
      const message = result as ToolMessage;
      expect(message.content).to.equal('boom');
      expect(message.tool_call_id).to.equal('call-1');
      expect(message.name).to.equal('flaky_tool');
      expect(message.status).to.equal('error');
      expect(warnCalls).to.have.lengthOf(1);
      const [, meta] = warnCalls[0] as [string, Record<string, unknown>];
      expect(meta.toolName).to.equal('flaky_tool');
    });

    it('handles a ToolException-shaped error the same way, with no special-casing by error type', async () => {
      const middleware = createToolErrorRecoveryMiddleware();
      const mcpError = Object.assign(
        new Error("MCP tool 'get_workflow_details' on server 'N8N' returned an error: archived"),
        { name: 'ToolException' },
      );
      const handler = async () => {
        throw mcpError;
      };

      const result = await middleware.wrapToolCall!(fakeToolCallRequest({}), handler);

      expect(result).to.be.instanceOf(ToolMessage);
      expect((result as ToolMessage).content).to.equal(mcpError.message);
      expect((result as ToolMessage).status).to.equal('error');
      expect(warnCalls).to.have.lengthOf(1);
    });

    it('stringifies a thrown non-Error value and still warns', async () => {
      const middleware = createToolErrorRecoveryMiddleware();
      const handler = async () => {
        throw 'a plain string failure';
      };

      const result = await middleware.wrapToolCall!(fakeToolCallRequest({}), handler);

      expect((result as ToolMessage).content).to.equal('a plain string failure');
      expect(warnCalls).to.have.lengthOf(1);
    });

    it('rethrows a GraphInterrupt unchanged, and does not warn', async () => {
      const middleware = createToolErrorRecoveryMiddleware();
      const interrupt = new GraphInterrupt([{ id: 'int-1', value: { question: 'approve?' } }]);
      const handler = async () => {
        throw interrupt;
      };

      let caught: unknown;
      try {
        await middleware.wrapToolCall!(fakeToolCallRequest({}), handler);
      } catch (err) {
        caught = err;
      }

      expect(caught).to.equal(interrupt);
      expect(warnCalls).to.have.lengthOf(0);
    });

    it('passes a successful ToolMessage result through unchanged', async () => {
      const middleware = createToolErrorRecoveryMiddleware();
      const real = new ToolMessage({ content: 'real result', tool_call_id: 'call-1' });
      const handler = async () => real;

      const result = await middleware.wrapToolCall!(fakeToolCallRequest({}), handler);

      expect(result).to.equal(real);
      expect(warnCalls).to.have.lengthOf(0);
    });

    it('passes a successful Command result through unchanged', async () => {
      const middleware = createToolErrorRecoveryMiddleware();
      const real = new Command({ update: { messages: [] } });
      const handler = async () => real;

      const result = await middleware.wrapToolCall!(fakeToolCallRequest({}), handler);

      expect(result).to.equal(real);
      expect(warnCalls).to.have.lengthOf(0);
    });
  });

  // Replays a fixed script of AI turns, one per model call — same pattern as
  // binary-content-fetch.middleware.test.ts. First turn calls a tool that
  // throws, second turn is the final plain-text reply — proving the graph
  // actually continues past the failure (through a real ToolNode, not just
  // a direct hook call) instead of the whole run crashing.
  class ScriptedChatModel extends BaseChatModel {
    private _callIndex = 0;

    _llmType() {
      return 'scripted-fake';
    }

    bindTools() {
      return this;
    }

    async _generate(): Promise<ChatResult> {
      this._callIndex += 1;
      const msg =
        this._callIndex === 1
          ? new AIMessage({
              content: '',
              tool_calls: [{ id: 'call_1', name: 'flaky_tool', args: {} }],
            })
          : new AIMessage({ content: 'Recovered after the tool failed.' });
      return { generations: [{ message: msg, text: '' }] };
    }
  }

  describe('orchestration — real createAgent graph [orchestration]', () => {
    it('recovers from a thrown tool error instead of crashing the run', async () => {
      const flakyTool = tool(
        async () => {
          throw new Error('boom');
        },
        { name: 'flaky_tool', description: 'Always throws.', schema: z.object({}) },
      );

      const agent = createAgent({
        model: new ScriptedChatModel({}),
        tools: [flakyTool],
        middleware: [createToolErrorRecoveryMiddleware()] as const,
      });

      const final = await agent.invoke({ messages: [new HumanMessage('do the flaky thing')] });

      const toolMessage = final.messages.find(
        (m: BaseMessage) => m.getType() === 'tool',
      ) as ToolMessage;
      expect(toolMessage.content).to.equal('boom');
      expect(toolMessage.status).to.equal('error');

      const lastMessage = final.messages[final.messages.length - 1] as BaseMessage;
      expect(lastMessage.getType()).to.equal('ai');
      expect(String(lastMessage.content)).to.equal('Recovered after the tool failed.');
    });
  });
});
