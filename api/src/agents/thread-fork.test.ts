import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import { tool } from '@langchain/core/tools';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import { forkThreadCheckpoints } from './thread-fork.js';

// A scripted fake chat model: inspects message history to decide what to
// say, so a real multi-step tool-calling turn can be driven deterministically
// through a real createAgent() graph + real SqliteSaver, without a live LLM.
// Turn content containing "add" triggers a tool call; everything else gets a
// plain echo response.
class ScriptedChatModel extends BaseChatModel {
  _llmType() {
    return 'scripted-fake';
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const last = messages[messages.length - 1]!;
    if (last.getType() === 'tool') {
      const text = `The sum is ${last.content as string}.`;
      return { generations: [{ message: new AIMessage(text), text }] };
    }
    const lastHuman = [...messages].reverse().find((m) => m.getType() === 'human');
    const content = typeof lastHuman?.content === 'string' ? lastHuman.content : '';
    if (content.includes('add')) {
      return {
        generations: [
          {
            message: new AIMessage({
              content: '',
              tool_calls: [{ id: 'call_1', name: 'add_numbers', args: { a: 2, b: 3 } }],
            }),
            text: '',
          },
        ],
      };
    }
    const text = `Echo: ${content}`;
    return { generations: [{ message: new AIMessage(text), text }] };
  }
}

const addNumbers = tool(async ({ a, b }: { a: number; b: number }) => String(a + b), {
  name: 'add_numbers',
  description: 'Adds two numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
});

function humanTypes(messages: BaseMessage[]): number {
  return messages.filter((m) => m.getType() === 'human').length;
}

describe('agents/thread-fork', () => {
  describe('forkThreadCheckpoints', () => {
    let dir: string;
    let db: Database.Database;
    let checkpointer: SqliteSaver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agent: any;
    let checkpointIdAfterTurn2: string;
    let stateAfterTurn2Messages: BaseMessage[];

    const sourceThreadId = 'src-thread';
    const forkedThreadId = 'forked-thread';
    const sourceConfig = { configurable: { thread_id: sourceThreadId } };
    const forkedConfig = { configurable: { thread_id: forkedThreadId } };

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'thread-fork-test-'));
      db = new Database(join(dir, 'test.db'));
      checkpointer = new SqliteSaver(db);
      agent = createAgent({ model: new ScriptedChatModel({}), tools: [addNumbers], checkpointer });

      // Turn 1: plain text.
      await agent.invoke({ messages: [{ role: 'human', content: 'hello' }] }, sourceConfig);
      // Turn 2: triggers a real tool-call/tool-result pair.
      await agent.invoke(
        { messages: [{ role: 'human', content: 'please add these' }] },
        sourceConfig,
      );

      const stateAfterTurn2 = await agent.getState(sourceConfig);
      checkpointIdAfterTurn2 = stateAfterTurn2.config.configurable.checkpoint_id as string;
      stateAfterTurn2Messages = stateAfterTurn2.values.messages;

      // Turn 3: more plain text, after the fork point.
      await agent.invoke({ messages: [{ role: 'human', content: 'thanks' }] }, sourceConfig);

      await forkThreadCheckpoints(
        checkpointer,
        sourceThreadId,
        checkpointIdAfterTurn2,
        forkedThreadId,
      );
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true });
    });

    it('reconstructs the exact state as of the fork point, including the tool-call/tool-result pair', async () => {
      const forkedState = await agent.getState(forkedConfig);
      expect(forkedState.values.messages).to.have.lengthOf(stateAfterTurn2Messages.length);
      expect(forkedState.values.messages.map((m: BaseMessage) => m.getType())).to.deep.equal(
        stateAfterTurn2Messages.map((m) => m.getType()),
      );
    });

    it('does not include turns that happened after the fork point', async () => {
      const forkedState = await agent.getState(forkedConfig);
      const contents = forkedState.values.messages.map((m: BaseMessage) => m.content);
      expect(contents).to.not.include('thanks');
    });

    it('the forked thread can be continued — proving checkpoint state is genuinely resumable, not just readable', async () => {
      await agent.invoke(
        { messages: [{ role: 'human', content: 'one more please add' }] },
        forkedConfig,
      );
      const forkedStateAfterContinue = await agent.getState(forkedConfig);
      const toolMsg = forkedStateAfterContinue.values.messages.find(
        (m: BaseMessage) => m.getType() === 'tool',
      );
      expect(
        toolMsg,
        'forked thread should have executed a new, real tool call after continuing',
      ).to.not.equal(undefined);
      expect(humanTypes(forkedStateAfterContinue.values.messages)).to.equal(3);
    });

    it('leaves the original thread completely independent of the fork', async () => {
      await agent.invoke(
        { messages: [{ role: 'human', content: 'one more on the original' }] },
        sourceConfig,
      );
      const origState = await agent.getState(sourceConfig);
      expect(humanTypes(origState.values.messages)).to.equal(4);
    });

    it('throws when the target checkpoint does not exist on the source thread', async () => {
      let threw = false;
      try {
        await forkThreadCheckpoints(
          checkpointer,
          sourceThreadId,
          'no-such-checkpoint',
          'another-fork',
        );
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });
  });
});
