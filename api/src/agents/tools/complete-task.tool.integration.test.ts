/**
 * Integration test: verifies, against a real LangChain createAgent() graph
 * (not a replayed event stream), that complete_task's tool body — and so its
 * onAccepted hook — actually runs inside agent.streamEvents(), and only for
 * an accepted call.
 *
 * This is the premise task-execution.ts relies on since issue #203:
 * completion is reported by the tool via onAccepted rather than by tapping
 * complete_task's on_tool_start event. If LangChain ever stopped executing
 * tool bodies within the streamed run, every automated task would silently
 * end 'failed' — task-execution.test.ts can't catch that, because its fake
 * agents invoke the tool themselves.
 */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { createAgent } from 'langchain';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import type { PlanStep } from '../../services/workspace-store.js';
import { makeCompleteTaskTool, type CompleteTaskCall } from './complete-task.tool.js';

// Replays a fixed script of AI turns, one per model call — each entry is
// either a complete_task call or (null) a final plain-text reply that ends
// the ReAct loop.
class ScriptedChatModel extends BaseChatModel {
  private _callIndex = 0;

  constructor(private readonly script: Array<CompleteTaskCall | null>) {
    super({});
  }

  _llmType() {
    return 'scripted-fake';
  }

  bindTools() {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const step = this.script[this._callIndex++] ?? null;
    const msg = step
      ? new AIMessage({
          content: '',
          tool_calls: [{ id: `call_${this._callIndex}`, name: 'complete_task', args: step }],
        })
      : new AIMessage({ content: 'Finished.' });
    return { generations: [{ message: msg, text: '' }] };
  }
}

const UNCHECKED_PLAN: PlanStep[] = [
  { step: 'Write the code', done: true },
  { step: 'Write the tests', done: false },
];

async function runScript(script: Array<CompleteTaskCall | null>) {
  const accepted: CompleteTaskCall[] = [];
  const agent = createAgent({
    model: new ScriptedChatModel(script),
    tools: [
      makeCompleteTaskTool('task-1', {
        getPlan: () => UNCHECKED_PLAN,
        onAccepted: (c) => accepted.push(c),
      }),
    ],
  });

  const toolOutputs: string[] = [];
  const stream = agent.streamEvents(
    { messages: [{ role: 'human', content: 'Begin work on this task now.' }] },
    { version: 'v2' },
  );
  for await (const evt of stream) {
    if (evt.event === 'on_tool_end' && evt.name === 'complete_task') {
      const output = evt.data?.output as unknown;
      toolOutputs.push(output instanceof ToolMessage ? String(output.content) : String(output));
    }
  }
  return { accepted, toolOutputs };
}

describe('agents/tools/complete-task (integration)', () => {
  it('fires onAccepted from inside a real streamEvents() run when complete_task is accepted [orchestration]', async () => {
    const { accepted } = await runScript([{ outcome: 'failed', summary: 'Blocked.' }, null]);

    expect(accepted).to.deep.equal([{ outcome: 'failed', summary: 'Blocked.' }]);
  });

  it('never fires onAccepted for a nudged call, and fires it for the repeated one [orchestration]', async () => {
    const { accepted, toolOutputs } = await runScript([
      { outcome: 'done', summary: 'first' },
      { outcome: 'done', summary: 'second' },
      null,
    ]);

    expect(toolOutputs[0]).to.include('Not completed: step 2 is still unchecked');
    expect(accepted).to.deep.equal([{ outcome: 'done', summary: 'second' }]);
  });
});
