import { describe, it } from 'mocha';
import { expect } from 'chai';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { ChatAnthropic } from '@langchain/anthropic';
import type { AIMessageChunk } from '@langchain/core/messages';

// Canary coverage (see the describe block's own header comment below for
// why this asserts the bug rather than the fix) for the bug described in
// https://github.com/tkottke90/amazing-hashbrown/issues/281 and
// docs/superpowers/specs/2026-10-08-provider-switch-content-block-leak-design.md:
// a thread's checkpoint can end up with a raw `input_json_delta` content
// block (an Anthropic streaming SSE delta-event type, never meant to
// survive into a settled message) once a tool-calling turn on Anthropic
// finishes streaming. That block is harmless on Anthropic/OpenAI's own
// APIs but gets rejected outright by stricter OpenAI-compatible gateways
// (observed against Digital Ocean) the moment a thread's provider is
// switched — breaking the thread.
//
// Root cause, traced directly in the installed @langchain/anthropic +
// @langchain/core source: `_makeMessageChunkFromAnthropicEvent` (in
// @langchain/anthropic's utils/message_outputs.js) builds each
// `input_json_delta` SSE event into a chunk whose content-block literally
// carries `type: data.delta.type` (i.e. "input_json_delta"), unlike its
// sibling branches for text/thinking deltas, which explicitly normalize
// `type` back to the settled block's name ("text"/"thinking") before
// yielding. @langchain/core's generic same-index chunk-merge logic
// (`getMergeableTypeBase` in messages/base.js) tries to tolerate a
// mismatched "_delta"-suffixed type by stripping the suffix and comparing
// bases — but it strips "input_json_delta" down to "input_json", which
// never matches the original block's "tool_use" type. So instead of
// merging into the existing tool_use block, every input_json_delta chunk
// gets pushed as its own separate, never-reconciled content-block entry —
// which is what ends up persisted.
//
// This test drives ChatAnthropic's real `.stream()` path (not a synthetic
// shortcut) by swapping in a fake Anthropic SDK client via the
// `createClient` constructor hook ChatAnthropic already exposes for this
// exact purpose — simpler and more robust than faking raw SSE bytes over a
// fetch/Response, since it skips the SDK's own wire-level parsing (not the
// system under test) and feeds already-parsed Anthropic event objects
// straight to the same `_streamResponseChunks` code path a real streamed
// response would hit. Tool binding matters here: @langchain/anthropic only
// emits content-block arrays (vs. a coerced plain string) when the
// outbound payload includes tool definitions — exactly the case for every
// agent in this app, which always binds a tool set.

interface FakeAnthropicStreamEvent {
  type: string;
  [key: string]: unknown;
}

function fakeAnthropicStream(events: FakeAnthropicStreamEvent[]) {
  async function* generate() {
    for (const event of events) yield event;
  }
  const iterator = generate();
  // _streamResponseChunks only reaches `stream.controller.abort()` when the
  // caller's AbortSignal fires mid-loop — not exercised here, but the
  // property must exist for that defensive check not to throw.
  (iterator as unknown as { controller: { abort: () => void } }).controller = {
    abort: () => {},
  };
  return iterator;
}

function makeStreamingChatAnthropic(events: FakeAnthropicStreamEvent[]): ChatAnthropic {
  const fakeClient = {
    messages: {
      create: async () => fakeAnthropicStream(events),
    },
  };
  return new ChatAnthropic({
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-5',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createClient: () => fakeClient as any,
  });
}

// Modeled directly on the wiki_lint tool call from the originating bug
// report's trace: a tool_use block whose `input` arguments stream in across
// two input_json_delta events before the block closes.
const WIKI_LINT_TOOL_CALL_EVENTS: FakeAnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_test', name: 'wiki_lint', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"wiki' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: 'Id":"user"}' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 15 },
  },
  { type: 'message_stop' },
];

// This is a canary, not a regression test in the usual sense: it documents
// a confirmed-still-present upstream bug (verified directly against
// @langchain/anthropic 1.5.12 / @langchain/core 1.2.17 — the latest
// versions available when this was written) rather than asserting the
// fixed behavior this app actually relies on. The real fix is
// content-block-sanitizer.middleware.ts, which strips the leaked block at
// the agent level regardless of what this test shows. If this assertion
// ever starts FAILING, that means the upstream bug has been fixed — take
// that as a prompt to re-evaluate whether the sanitizer middleware (and
// this canary) are still needed, not as something to chase back to green.
describe('ChatAnthropic tool-call streaming → content-block merge [unit]', () => {
  it('canary: @langchain/anthropic still leaves a raw input_json_delta block in the merged AIMessage content', async () => {
    const wikiLintTool = tool(async () => 'ok', {
      name: 'wiki_lint',
      description: 'Lint a wiki domain for quality issues.',
      schema: z.object({ wikiId: z.string() }),
    });
    const model = makeStreamingChatAnthropic(WIKI_LINT_TOOL_CALL_EVENTS).bindTools([wikiLintTool]);

    let finalChunk: AIMessageChunk | undefined;
    for await (const chunk of await model.stream('irrelevant — the fake client ignores input')) {
      finalChunk = finalChunk === undefined ? chunk : finalChunk.concat(chunk);
    }

    expect(finalChunk, 'expected at least one streamed chunk').to.not.equal(undefined);
    const content = finalChunk!.content;
    expect(Array.isArray(content), 'expected merged content to be a content-block array').to.equal(
      true,
    );

    const blockTypes = (content as Array<{ type?: string }>).map((block) => block.type);
    expect(
      blockTypes,
      `merged content blocks were ${JSON.stringify(content)} — expected the still-present ` +
        'upstream bug to leave a raw "input_json_delta" block un-merged; if this fails, the ' +
        'bug may be fixed upstream',
    ).to.include('input_json_delta');
  });
});
