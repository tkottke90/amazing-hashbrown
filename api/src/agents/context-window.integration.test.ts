/**
 * Integration test: verifies that a real Turn Overflow (see GLOSSARY.md) —
 * a single Turn's own tool output exceeding the trim budget — is actually
 * handled through a real LangGraph graph run (real checkpointer, real
 * streamEvents()), not just the isolated boundaryAwareTrim() calls
 * summary-boundary.test.ts exercises directly.
 *
 * Mirrors loop-guard.integration.test.ts's scaffold exactly (temp-file
 * SqliteSaver, a fake BaseChatModel forcing a deterministic tool call that
 * returns an oversized result).
 *
 * Two behaviors, one per describe block:
 *  - beforeModel's persisted-state trim (no MIN_BUDGET_FLOOR floor) throws
 *    ContextBudgetExceededError when even a fully truncated Turn can't fit
 *    an absurdly tiny configured budget.
 *  - wrapModelCall's call-scoped trim (floored at MIN_BUDGET_FLOOR) recovers
 *    automatically from a real oversized tool result — the graph completes
 *    instead of throwing or (the original #354 bug) answering with a
 *    disconnected reply from an anchorless context.
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
import { createContextWindowMiddleware } from './chat-agent.js';

// First call (no tool result in history yet): requests a tool call that
// returns an oversized result. Second call (a tool result is present):
// answers plainly — reaching this branch at all proves the graph survived
// the Turn Overflow instead of throwing or going silent.
class BigToolCallChatModel extends BaseChatModel {
  _llmType() {
    return 'big-tool-call-fake';
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const hasToolResult = messages.some((m) => m.getType() === 'tool');
    if (!hasToolResult) {
      const msg = new AIMessage({
        content: '',
        tool_calls: [{ id: `call_${Math.random()}`, name: 'big_tool', args: {} }],
      });
      return { generations: [{ message: msg, text: '' }] };
    }
    const msg = new AIMessage({ content: 'done' });
    return { generations: [{ message: msg, text: 'done' }] };
  }
}

const bigTool = tool(async () => 'y'.repeat(50_000), {
  name: 'big_tool',
  description: 'Returns an oversized result, forcing a Turn Overflow',
  schema: z.object({}),
});

describe('agents/context-window (integration)', () => {
  describe('beforeModel path: unrecoverable Turn Overflow', () => {
    let dir: string;
    let db: Database.Database;
    let checkpointer: SqliteSaver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agent: any;

    const threadId = 'context-window-before-model-integration-thread';
    const config = { configurable: { thread_id: threadId } };

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'context-window-before-model-integration-'));
      db = new Database(join(dir, 'test.db'));
      checkpointer = new SqliteSaver(db);
      agent = createAgent({
        model: new BigToolCallChatModel({}),
        tools: [bigTool],
        checkpointer,
        // An absurdly tiny budget — beforeModel's trim isn't floored at
        // MIN_BUDGET_FLOOR the way wrapModelCall's is, so this reliably
        // can't fit even a fully-truncated Turn (a minimal offloaded stub
        // alone already exceeds it).
        middleware: [
          createContextWindowMiddleware({ enabled: true, maxTokens: 50, safetyMarginPct: 0.85 }),
        ],
      });
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true });
    });

    it('throws ContextBudgetExceededError instead of silently emptying the Turn', async () => {
      let caughtError: unknown = null;
      try {
        const stream = agent.streamEvents(
          { messages: [{ role: 'human', content: 'go' }] },
          { ...config, version: 'v2' },
        );
        for await (const _event of stream) {
          // drain
        }
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError, 'should throw rather than silently continue').to.not.equal(null);
      // LangGraph can wrap a thrown-from-middleware error; the original is
      // reachable the same way task-execution.ts's own catch chain already
      // relies on for StagnationLimitError/GraphInterrupt — by `.name`, not
      // `instanceof` (see that file's comment on why).
      const err = caughtError as Error;
      const isDirect = err.name === 'ContextBudgetExceededError';
      const cause = (err as Error & { cause?: unknown }).cause;
      const isWrapped = (cause as Error)?.name === 'ContextBudgetExceededError';
      expect(
        isDirect || isWrapped,
        `expected a ContextBudgetExceededError, got ${err.name}: ${err.message}`,
      ).to.equal(true);
    });
  });

  describe('wrapModelCall path: automatic recovery from a real Turn Overflow', () => {
    let dir: string;
    let db: Database.Database;
    let checkpointer: SqliteSaver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agent: any;

    const threadId = 'context-window-wrap-model-call-integration-thread';
    const config = { configurable: { thread_id: threadId } };

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'context-window-wrap-model-call-integration-'));
      db = new Database(join(dir, 'test.db'));
      checkpointer = new SqliteSaver(db);
      agent = createAgent({
        model: new BigToolCallChatModel({}),
        tools: [bigTool],
        checkpointer,
        // Comfortably above MIN_BUDGET_FLOOR (2000) once tool-schema
        // overhead is subtracted, but nowhere near enough to hold the
        // 50,000-char tool result unmodified — the Turn only fits once
        // that result has been truncated.
        middleware: [
          createContextWindowMiddleware({ enabled: true, maxTokens: 3000, safetyMarginPct: 0.85 }),
        ],
      });
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true });
    });

    it('completes the turn instead of throwing or answering from an anchorless context — the original #354 symptom', async () => {
      let caughtError: unknown = null;
      try {
        const stream = agent.streamEvents(
          { messages: [{ role: 'human', content: 'go' }] },
          { ...config, version: 'v2' },
        );
        for await (const _event of stream) {
          // drain
        }
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError, 'should recover automatically, not throw').to.equal(null);

      const state = await agent.graph.getState(config);
      const aiMessages = (state.values?.messages ?? []).filter(
        (m: BaseMessage) => m.getType() === 'ai',
      );
      const plainReply = aiMessages.find((m: BaseMessage) => String(m.content) === 'done');
      expect(
        plainReply,
        'the model should have reached its second call and answered plainly, proving the Turn ' +
          'Overflow was recovered rather than the model seeing an anchorless/empty context',
      ).to.not.equal(undefined);
    });
  });
});
