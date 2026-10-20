import { describe, it } from 'mocha';
import { expect } from 'chai';
import { createAgent } from 'langchain';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { createSkillScopedToolsMiddleware } from './skill-scoped-tools.middleware.js';

function fakeTool(name: string) {
  return { name } as unknown as { name: string };
}

function fakeModelRequest(tools: { name: string }[], activeSkill: string | null) {
  return {
    tools,
    state: { activeSkill },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('agents/skill-scoped-tools.middleware', () => {
  describe('wrapModelCall [unit]', () => {
    it('hides read_skill_reference/run_skill_script when no skill is active', async () => {
      const middleware = createSkillScopedToolsMiddleware();
      const tools = [
        fakeTool('ask_user'),
        fakeTool('read_skill_reference'),
        fakeTool('run_skill_script'),
      ];
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(fakeModelRequest(tools, null), handler);

      expect(seenTools.map((t) => t.name)).to.deep.equal(['ask_user']);
    });

    it('exposes both tools once any skill is active', async () => {
      const middleware = createSkillScopedToolsMiddleware();
      const tools = [
        fakeTool('ask_user'),
        fakeTool('read_skill_reference'),
        fakeTool('run_skill_script'),
      ];
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(fakeModelRequest(tools, 'wiki-search'), handler);

      expect(seenTools.map((t) => t.name)).to.deep.equal([
        'ask_user',
        'read_skill_reference',
        'run_skill_script',
      ]);
    });
  });

  describe('wrapToolCall [unit]', () => {
    it('passes through unchanged for a tool call that is not skill-scoped', async () => {
      const middleware = createSkillScopedToolsMiddleware();
      let handlerCalled = false;
      const handler = async (req: { runtime: { configurable?: Record<string, unknown> } }) => {
        handlerCalled = true;
        return new ToolMessage({
          content: JSON.stringify(req.runtime.configurable ?? null),
          tool_call_id: 'call-1',
        });
      };

      const result = await middleware.wrapToolCall!(
        {
          toolCall: { id: 'call-1', name: 'ask_user', args: {} },
          tool: undefined,
          state: { activeSkill: 'wiki-search' },
          runtime: { configurable: { workspaceId: 'w1' } },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        handler,
      );

      expect(handlerCalled).to.equal(true);
      expect(JSON.parse((result as ToolMessage).content as string)).to.deep.equal({
        workspaceId: 'w1',
      });
    });
  });

  // Replays a fixed script of AI turns, one per model call. First turn calls
  // probe_tool, second turn is the final plain-text reply — same pattern as
  // binary-content-fetch.middleware.test.ts.
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
              tool_calls: [{ id: 'call_1', name: 'probe_tool', args: {} }],
            })
          : new AIMessage({ content: 'done' });
      return { generations: [{ message: msg, text: '' }] };
    }
  }

  describe('orchestration — real createAgent graph [orchestration]', () => {
    it('propagates activeSkill into the real tool handler via runtime.configurable', async () => {
      // Proves the "mutate request.runtime, forward to handler" pattern
      // actually works through a real LangGraph ToolNode — not just that
      // wrapToolCall calls handler() with the object we built (that part a
      // fake-handler unit test would already prove, and isn't the risky
      // part). No existing tool in this repo reads graph state from inside
      // its handler at all — this is the one place that behavior is load-
      // bearing, so it gets the real-graph treatment rather than a mock.
      const probeTool = tool(
        async (_args, runtime: ToolRuntime) =>
          JSON.stringify({ seen: runtime.configurable?.activeSkill ?? null }),
        {
          name: 'probe_tool',
          description: 'Reports the injected activeSkill.',
          schema: z.object({}),
        },
      );

      const agent = createAgent({
        model: new ScriptedChatModel({}),
        tools: [probeTool],
        middleware: [createSkillScopedToolsMiddleware()] as const,
      });

      const final = await agent.invoke({
        messages: [new HumanMessage('go')],
        activeSkill: 'some-skill',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const toolMessage = final.messages.find(
        (m: BaseMessage) => m.getType() === 'tool',
      ) as ToolMessage;
      expect(JSON.parse(String(toolMessage.content))).to.deep.equal({ seen: 'some-skill' });
    });
  });
});
