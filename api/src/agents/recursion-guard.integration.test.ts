/**
 * Integration test: verifies that the recursion guard fires an interrupt()
 * before GraphRecursionError, and that resuming with Command({resume}) gives
 * the graph a fresh recursion budget so it can make additional progress.
 *
 * This is the KEY correctness assertion for the recursion guard feature.
 * Failure here means the budget does NOT reset on resume, and the guard
 * provides no practical benefit over the hard error catch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Command } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { tool } from '@langchain/core/tools';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import { createRecursionGuardMiddleware } from './recursion-guard.middleware.js';

// Always makes exactly one tool call per LLM call, causing a loop.
// Never produces a final text response — only stops when interrupted.
class LoopingChatModel extends BaseChatModel {
  private _callIndex = 0;

  _llmType() {
    return 'looping-fake';
  }

  bindTools() {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const id = `call_${++this._callIndex}`;
    const msg = new AIMessage({
      content: '',
      tool_calls: [{ id, name: 'no_op', args: {} }],
    });
    return { generations: [{ message: msg, text: '' }] };
  }
}

const noOpTool = tool(async () => 'ok', {
  name: 'no_op',
  description: 'Does nothing',
  schema: z.object({}),
});

describe('agents/recursion-guard (integration)', () => {
  // recursionLimit=20, warnThreshold=0.1 → threshold = floor(20*0.1) = 2
  // Guard fires when completedSteps (AIMessages) is a non-zero multiple of 2.
  // With the LoopingModel (1 tool call per LLM call = 2 steps per cycle),
  // the guard fires at LLM call 3 (steps 4-5), well under limit=20.
  const RECURSION_LIMIT = 20;
  const WARN_THRESHOLD = 0.1; // threshold = 2

  let dir: string;
  let db: Database.Database;
  let checkpointer: SqliteSaver;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agent: any;

  const threadId = 'guard-integration-thread';
  const config = { configurable: { thread_id: threadId } };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'recursion-guard-integration-'));
    db = new Database(join(dir, 'test.db'));
    checkpointer = new SqliteSaver(db);
    agent = createAgent({
      model: new LoopingChatModel({}),
      tools: [noOpTool],
      checkpointer,
      middleware: [createRecursionGuardMiddleware(RECURSION_LIMIT, WARN_THRESHOLD)],
    });
  });

  after(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });

  it('guard fires interrupt before GraphRecursionError on the first invocation', async () => {
    // Drive the graph until it pauses (interrupt) or fails (error).
    // We use streamEvents and collect all events.
    let caughtError: Error | null = null;
    let streamedCount = 0;
    try {
      const stream = agent.streamEvents(
        { messages: [{ role: 'human', content: 'go' }] },
        { ...config, version: 'v2', recursionLimit: RECURSION_LIMIT },
      );
      for await (const _event of stream) {
        streamedCount++;
      }
    } catch (err) {
      caughtError = err as Error;
    }

    // The guard should have interrupted the graph before GraphRecursionError.
    // The graph pauses gracefully — no error thrown to the caller.
    expect(caughtError?.name ?? null, 'should not throw GraphRecursionError').to.not.equal(
      'GraphRecursionError',
    );
    expect(caughtError, 'should not throw any error').to.equal(null);
    expect(streamedCount, 'should have streamed at least one event').to.be.greaterThan(0);

    // Confirm the graph is paused with an interrupt (not crashed).
    const state = await agent.graph.getState(config);
    expect(
      state.tasks?.[0]?.interrupts?.length,
      'graph should have a pending interrupt',
    ).to.be.greaterThan(0);

    const interruptValue = state.tasks[0].interrupts[0].value;
    expect(interruptValue?.kind).to.equal('recursion_limit_warning');
    expect(interruptValue?.stepsUsed).to.be.a('number');
    expect(interruptValue?.choices).to.be.an('array');
  });

  it('resuming with Continue working gives a fresh budget — agent makes additional progress without GraphRecursionError', async () => {
    // The graph was paused at step ~5. Resume with full recursionLimit=20.
    // The resumed invocation should make at least 1 more LLM call (proving fresh budget).
    let resumeError: Error | null = null;
    let resumeEventCount = 0;

    try {
      const stream = agent.streamEvents(new Command({ resume: 'Continue working' }), {
        ...config,
        version: 'v2',
        recursionLimit: RECURSION_LIMIT,
      });
      for await (const _event of stream) {
        resumeEventCount++;
      }
    } catch (err) {
      resumeError = err as Error;
    }

    // The resumed graph should NOT immediately fail with GraphRecursionError.
    // If the budget did NOT reset, the first agent_node execution would exceed
    // the prior step count and fail before doing any work.
    expect(
      resumeError?.name ?? null,
      'resumed graph should not throw GraphRecursionError',
    ).to.not.equal('GraphRecursionError');
    expect(resumeEventCount, 'resumed graph should stream additional events').to.be.greaterThan(0);

    // Verify the agent made at least one additional LLM call by checking state.
    const stateAfterResume = await agent.graph.getState(config);
    const aiMessages = (stateAfterResume.values?.messages ?? []).filter(
      (m: BaseMessage) => m.getType() === 'ai',
    );
    // Before resume: 2 AIMessages. After: at least 3 (at least 1 more LLM call).
    expect(
      aiMessages.length,
      'agent should have made additional LLM calls after resume',
    ).to.be.greaterThan(2);
  });
});
