/**
 * Integration test: verifies the loop guard's stagnation -> nudge ->
 * reflection -> escalate ladder actually fires through a real LangGraph
 * graph (real checkpointer, real interrupt()/resume machinery), not just
 * the isolated beforeModel() calls recursion-guard.middleware.test.ts
 * exercises directly.
 *
 * Reflection's own LLM call is stubbed (via createRecursionGuardMiddleware's
 * evaluateLoopProgress test-only override) — this test is about the graph
 * plumbing around that call, not the reflection prompt itself (covered by
 * loop-reflection.test.ts).
 *
 * Mirrors recursion-guard.integration.test.ts's scaffold exactly (temp-file
 * SqliteSaver, a fake BaseChatModel forcing a deterministic loop).
 *
 * Per the implementation plan's pre-flight finding: buildSubAgentAgent is
 * not currently wired into any production code path (task-execution.ts
 * always builds via buildTaskAgent), so the throw-mode test below drives a
 * createAgent() configured the same way buildSubAgentAgent configures its
 * own middleware, rather than going through executeTask().
 */
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
import {
  createRecursionGuardMiddleware,
  StagnationLimitError,
} from './recursion-guard.middleware.js';

// Always calls the same tool with the same args, and the tool always returns
// the same result — a deterministic stagnation loop, unlike
// recursion-guard.integration.test.ts's LoopingChatModel (which just forces
// *a* loop, with no notion of repeated output).
class StagnantChatModel extends BaseChatModel {
  _llmType() {
    return 'stagnant-fake';
  }

  bindTools() {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const msg = new AIMessage({
      content: '',
      tool_calls: [{ id: `call_${Math.random()}`, name: 'no_op', args: {} }],
    });
    return { generations: [{ message: msg, text: '' }] };
  }
}

const noOpTool = tool(async () => 'ok', {
  name: 'no_op',
  description: 'Does nothing, always returns the same result',
  schema: z.object({}),
});

const LOOP_GUARD = {
  enabled: true,
  stagnationNudgeThreshold: 2,
  stagnationReflectionThreshold: 3,
  streakReflectionThreshold: 100, // not under test here — kept well out of reach
};

describe('agents/loop-guard (integration)', () => {
  describe('interrupt mode (chat/task runs)', () => {
    let dir: string;
    let db: Database.Database;
    let checkpointer: SqliteSaver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agent: any;

    const threadId = 'loop-guard-integration-thread';
    const config = { configurable: { thread_id: threadId } };

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'loop-guard-integration-'));
      db = new Database(join(dir, 'test.db'));
      checkpointer = new SqliteSaver(db);
      agent = createAgent({
        model: new StagnantChatModel({}),
        tools: [noOpTool],
        checkpointer,
        middleware: [
          createRecursionGuardMiddleware({
            recursionLimit: 1000,
            warnThreshold: 0.99, // step-count threshold (990) stays well out of reach
            loopGuard: LOOP_GUARD,
            escalationMode: 'interrupt',
            evaluateLoopProgress: async () => ({
              converging: false,
              summary: 'Stuck calling no_op repeatedly with no new information.',
            }),
          }),
        ],
      });
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true });
    });

    it('nudges first, then escalates via a loop_stagnation_warning interrupt once the stubbed reflection reports non-convergence', async () => {
      let caughtError: Error | null = null;
      try {
        const stream = agent.streamEvents(
          { messages: [{ role: 'human', content: 'go' }] },
          { ...config, version: 'v2', recursionLimit: 1000 },
        );
        for await (const _event of stream) {
          // drain
        }
      } catch (err) {
        caughtError = err as Error;
      }

      expect(caughtError, 'graph should pause gracefully, not throw').to.equal(null);

      const state = await agent.graph.getState(config);

      // The nudge (at streak === 2) was injected as a plain HumanMessage, not
      // an interrupt — the graph kept running past it. Confirm it's present
      // in state before reflection (at streak === 3) escalated.
      const humanMessages = (state.values?.messages ?? []).filter(
        (m: BaseMessage) => m.getType() === 'human',
      );
      const nudgeMessage = humanMessages.find((m: BaseMessage) =>
        String(m.content).includes('no_op'),
      );
      expect(nudgeMessage, 'the nudge HumanMessage should be present in state').to.not.equal(
        undefined,
      );

      expect(
        state.tasks?.[0]?.interrupts?.length,
        'graph should have a pending interrupt after reflection escalates',
      ).to.be.greaterThan(0);
      const interruptValue = state.tasks[0].interrupts[0].value;
      expect(interruptValue?.kind).to.equal('loop_stagnation_warning');
      expect(interruptValue?.summary).to.equal(
        'Stuck calling no_op repeatedly with no new information.',
      );
      expect(interruptValue?.choices).to.be.an('array');
    });
  });

  describe('throw mode (sub-agent runs)', () => {
    let dir: string;
    let db: Database.Database;
    let checkpointer: SqliteSaver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agent: any;

    const threadId = 'loop-guard-throw-integration-thread';
    const config = { configurable: { thread_id: threadId } };

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'loop-guard-throw-integration-'));
      db = new Database(join(dir, 'test.db'));
      checkpointer = new SqliteSaver(db);
      agent = createAgent({
        model: new StagnantChatModel({}),
        tools: [noOpTool],
        checkpointer,
        // Same configuration buildSubAgentAgent gives its own instance of
        // this middleware — see chat-agent.ts.
        middleware: [
          createRecursionGuardMiddleware({
            recursionLimit: 25,
            warnThreshold: 0.75,
            loopGuard: LOOP_GUARD,
            escalationMode: 'throw',
            evaluateLoopProgress: async () => ({
              converging: false,
              summary: 'Stuck calling no_op repeatedly with no new information.',
            }),
          }),
        ],
      });
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true });
    });

    it('throws StagnationLimitError instead of interrupting — nothing can resume an interrupt() in a sub-agent run', async () => {
      let caughtError: unknown = null;
      try {
        const stream = agent.streamEvents(
          { messages: [{ role: 'human', content: 'go' }] },
          { ...config, version: 'v2', recursionLimit: 25 },
        );
        for await (const _event of stream) {
          // drain
        }
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError, 'should throw rather than pause').to.not.equal(null);
      // LangGraph wraps a thrown-from-middleware error; the original is
      // reachable the same way task-execution.ts's own catch chain already
      // relies on for GraphInterrupt (by .name, not instanceof — see that
      // file's comment on why).
      const err = caughtError as Error;
      const isDirect = err.name === 'StagnationLimitError';
      const cause = (err as Error & { cause?: unknown }).cause;
      const isWrapped =
        cause instanceof StagnationLimitError || (cause as Error)?.name === 'StagnationLimitError';
      expect(
        isDirect || isWrapped,
        `expected a StagnationLimitError, got ${err.name}: ${err.message}`,
      ).to.equal(true);
    });
  });
});
