/**
 * Integration test: verifies that createHistoryCompactionMiddleware actually
 * condenses an older ToolMessage inside a real LangGraph graph run (real
 * checkpointer, real streamEvents()) before createContextWindowMiddleware's
 * own trim stage ever sees it — the central interaction claim of
 * docs/superpowers/specs/2026-11-19-history-compaction-middleware-design.md.
 *
 * Mirrors context-window.integration.test.ts's scaffold exactly (temp-file
 * SqliteSaver, a fake BaseChatModel forcing a deterministic tool-call
 * sequence). Uses createHistoryCompactionMiddleware's
 * summarizeToolMessage/resolveSummarizerModel injection seam (same one the
 * unit tests use) so this test needs no live provider and no
 * bootObservability() setup — only the turn's own main model is a fake.
 *
 * Needs *two* tool-call rounds before the final answer: compaction always
 * protects the single most-recent round, so a one-round turn (like
 * context-window.integration.test.ts's) never has anything eligible. Round 1
 * (big_tool, oversized result) becomes eligible only once round 2
 * (small_tool) exists and the loop is about to call the model a third time.
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
import { AIMessage, ToolMessage, isToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import { createContextWindowMiddleware } from './chat-agent.js';
import { createHistoryCompactionMiddleware } from './history-compaction.middleware.js';

const BIG_RESULT = 'y'.repeat(50_000);
const COMPACTED_MARKER = 'CONDENSED-STUB';

// Three-call sequence, branching purely on how many tool results are
// already in history: 0 -> call big_tool, 1 -> call small_tool, 2+ ->
// inspect big_tool's current ToolMessage content and answer accordingly.
// Answering with the content it actually sees (rather than a fixed string)
// is what lets the test prove compaction ran before this third call,
// without needing a real summarizer model.
class SequencedToolCallChatModel extends BaseChatModel {
  _llmType() {
    return 'sequenced-tool-call-fake';
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const toolMessages = messages.filter(isToolMessage);

    if (toolMessages.length === 0) {
      const msg = new AIMessage({
        content: '',
        tool_calls: [{ id: `call_big_${Math.random()}`, name: 'big_tool', args: {} }],
      });
      return { generations: [{ message: msg, text: '' }] };
    }

    if (toolMessages.length === 1) {
      const msg = new AIMessage({
        content: '',
        tool_calls: [{ id: `call_small_${Math.random()}`, name: 'small_tool', args: {} }],
      });
      return { generations: [{ message: msg, text: '' }] };
    }

    const bigToolResult = toolMessages.find((m) => m.name === 'big_tool');
    const content = String(bigToolResult?.content ?? '');
    const answer = content.includes(COMPACTED_MARKER) ? 'saw-compacted' : 'saw-original';
    const msg = new AIMessage({ content: answer });
    return { generations: [{ message: msg, text: answer }] };
  }
}

const bigTool = tool(async () => BIG_RESULT, {
  name: 'big_tool',
  description: 'Returns an oversized result, forcing a History Compaction candidate',
  schema: z.object({}),
});

const smallTool = tool(async () => 'ok', {
  name: 'small_tool',
  description: 'Returns a tiny result — the protected most-recent round when it runs',
  schema: z.object({}),
});

// Thresholds chosen so this is comfortably within contextWindow's own trim
// ceiling (20000 * 0.85 = 17000 tokens / 68000 chars — bigger than the
// 50,000-char result alone) but well over historyCompaction's own
// threshold (20000 * 0.1 = 2000 tokens / 8000 chars) — isolates the effect
// to compaction, not a conflated trim.
const contextWindowCfg = { enabled: true, maxTokens: 20_000, safetyMarginPct: 0.85 };
const historyCompactionCfg = {
  enabled: true,
  thresholdPct: 0.1,
  summarizerProvider: undefined,
  summarizerModel: undefined,
  maxSourceChars: 16_000,
};

// Neither test needs a real provider: the summarizeToolMessage/
// resolveSummarizerModel injection seam (same one
// history-compaction.middleware.test.ts uses) stands in for the summarizer.
const fakeResolveSummarizerModel = () => ({
  llm: {} as BaseChatModel,
  resolvedProvider: 'fake',
  resolvedModel: 'fake',
});
const fakeSummarizeToolMessage = async (original: ToolMessage) =>
  new ToolMessage({
    content: COMPACTED_MARKER,
    tool_call_id: original.tool_call_id,
    name: original.name,
    id: original.id,
    additional_kwargs: { hashbrown: { kind: 'history-compaction', toolKey: 'kv_fake' } },
  });

describe('agents/history-compaction (integration)', () => {
  describe('with historyCompactionMiddleware wired in', () => {
    let dir: string;
    let db: Database.Database;
    let checkpointer: SqliteSaver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agent: any;

    const threadId = 'history-compaction-integration-thread';
    const config = { configurable: { thread_id: threadId } };

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'history-compaction-integration-'));
      db = new Database(join(dir, 'test.db'));
      checkpointer = new SqliteSaver(db);
      agent = createAgent({
        model: new SequencedToolCallChatModel({}),
        tools: [bigTool, smallTool],
        checkpointer,
        middleware: [
          createHistoryCompactionMiddleware(contextWindowCfg, historyCompactionCfg, {
            summarizeToolMessage: fakeSummarizeToolMessage,
            resolveSummarizerModel: fakeResolveSummarizerModel,
          }),
          createContextWindowMiddleware(contextWindowCfg),
        ],
      });
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true });
    });

    it('condenses the earlier big_tool result before ContextWindowMiddleware ever sees it', async () => {
      const stream = agent.streamEvents(
        { messages: [{ role: 'human', content: 'go' }] },
        { ...config, version: 'v2' },
      );
      for await (const _event of stream) {
        // drain
      }

      const state = await agent.graph.getState(config);
      const messages = (state.values?.messages ?? []) as BaseMessage[];

      const bigToolMessage = messages.find((m) => isToolMessage(m) && m.name === 'big_tool');
      expect(bigToolMessage, 'big_tool ToolMessage should still be present').to.not.equal(
        undefined,
      );
      expect(String(bigToolMessage!.content)).to.equal(COMPACTED_MARKER);

      const aiMessages = messages.filter((m) => m.getType() === 'ai');
      const finalAnswer = aiMessages.find(
        (m) => String(m.content) === 'saw-compacted' || String(m.content) === 'saw-original',
      );
      expect(
        finalAnswer?.content,
        'the model, on its third call, should have seen the already-compacted content',
      ).to.equal('saw-compacted');
    });
  });

  describe('control: without historyCompactionMiddleware', () => {
    let dir: string;
    let db: Database.Database;
    let checkpointer: SqliteSaver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agent: any;

    const threadId = 'history-compaction-integration-control-thread';
    const config = { configurable: { thread_id: threadId } };

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'history-compaction-integration-control-'));
      db = new Database(join(dir, 'test.db'));
      checkpointer = new SqliteSaver(db);
      agent = createAgent({
        model: new SequencedToolCallChatModel({}),
        tools: [bigTool, smallTool],
        checkpointer,
        // Same contextWindowCfg, no historyCompactionMiddleware at all —
        // proves the 'saw-compacted' result above is attributable to this
        // middleware, not an artifact of the fake model or ContextWindow's
        // own trim (which this test's thresholds keep well clear of).
        middleware: [createContextWindowMiddleware(contextWindowCfg)],
      });
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true });
    });

    it('leaves the earlier big_tool result untouched, and the model sees the original', async () => {
      const stream = agent.streamEvents(
        { messages: [{ role: 'human', content: 'go' }] },
        { ...config, version: 'v2' },
      );
      for await (const _event of stream) {
        // drain
      }

      const state = await agent.graph.getState(config);
      const messages = (state.values?.messages ?? []) as BaseMessage[];

      const bigToolMessage = messages.find((m) => isToolMessage(m) && m.name === 'big_tool');
      expect(String(bigToolMessage!.content)).to.equal(BIG_RESULT);

      const aiMessages = messages.filter((m) => m.getType() === 'ai');
      const finalAnswer = aiMessages.find(
        (m) => String(m.content) === 'saw-compacted' || String(m.content) === 'saw-original',
      );
      expect(finalAnswer?.content).to.equal('saw-original');
    });
  });
});
