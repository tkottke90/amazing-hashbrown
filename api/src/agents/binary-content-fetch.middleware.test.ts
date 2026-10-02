import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createAgent } from 'langchain';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootObservability, getObservabilityStore } from '../services/observability.js';
import { bootArtifactStore, storeArtifact, getArtifactMeta } from '../artifacts/artifact-store.js';
import { storeToolContent, storeBinaryToolContent } from '../services/tool-content-store.js';
import { getToolKeyTool } from './tools/get-tool-key.tool.js';
import { createBinaryContentFetchMiddleware } from './binary-content-fetch.middleware.js';

function fakeRuntime(opts: { provider?: string; model?: string; traceId?: string } = {}) {
  return {
    context: { provider: opts.provider, model: opts.model },
    configurable: opts.traceId ? { trace_id: opts.traceId } : {},
  } as Parameters<
    ReturnType<typeof createBinaryContentFetchMiddleware>['wrapToolCall'] & object
  >[0]['runtime'];
}

function fakeToolCallRequest(
  args: Record<string, unknown>,
  runtime: ReturnType<typeof fakeRuntime>,
  name = 'get_tool_key',
) {
  return {
    toolCall: { id: 'call-1', name, args },
    tool: undefined,
    state: { messages: [], pendingImageFetch: null },
    runtime,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('agents/binary-content-fetch.middleware', () => {
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'binary-content-fetch-test-'));
    await bootArtifactStore(dir);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('wrapToolCall [unit]', () => {
    it('passes through unchanged for a tool call that is not get_tool_key', async () => {
      const middleware = createBinaryContentFetchMiddleware(async () => true);
      let handlerCalled = false;
      const handler = async () => {
        handlerCalled = true;
        return new ToolMessage({ content: 'real result', tool_call_id: 'call-1' });
      };

      const result = await middleware.wrapToolCall!(
        fakeToolCallRequest({ foo: 'bar' }, fakeRuntime(), 'some_other_tool'),
        handler,
      );

      expect(handlerCalled).to.equal(true);
      expect((result as ToolMessage).content).to.equal('real result');
    });

    it('passes through unchanged for a get_tool_key call with no matching entry', async () => {
      const middleware = createBinaryContentFetchMiddleware(async () => true);
      let handlerCalled = false;
      const handler = async () => {
        handlerCalled = true;
        return new ToolMessage({ content: 'not found', tool_call_id: 'call-1' });
      };

      const result = await middleware.wrapToolCall!(
        fakeToolCallRequest({ threadId: 'thread-x', toolKey: 'does-not-exist' }, fakeRuntime()),
        handler,
      );

      expect(handlerCalled).to.equal(true);
      expect((result as ToolMessage).content).to.equal('not found');
    });

    it('passes through unchanged for a get_tool_key call referencing a text entry', async () => {
      storeToolContent('thread-text', 'key-1', 'some offloaded text');
      const middleware = createBinaryContentFetchMiddleware(async () => true);
      let handlerCalled = false;
      const handler = async () => {
        handlerCalled = true;
        return new ToolMessage({ content: 'some offloaded text', tool_call_id: 'call-1' });
      };

      const result = await middleware.wrapToolCall!(
        fakeToolCallRequest({ threadId: 'thread-text', toolKey: 'key-1' }, fakeRuntime()),
        handler,
      );

      expect(handlerCalled).to.equal(true);
      expect((result as ToolMessage).content).to.equal('some offloaded text');
    });

    it('returns a Command setting pendingImageFetch when the model is vision-capable', async () => {
      storeBinaryToolContent('thread-bin', 'key-2', 'attachment-1');
      const middleware = createBinaryContentFetchMiddleware(async () => true);
      const handler = async () => {
        throw new Error('the real tool handler must not be called for a binary entry');
      };

      const result = await middleware.wrapToolCall!(
        fakeToolCallRequest(
          { threadId: 'thread-bin', toolKey: 'key-2' },
          fakeRuntime({ provider: 'ollama', model: 'llava' }),
        ),
        handler,
      );

      expect(result).to.be.instanceOf(Command);
      const update = (result as Command).update as {
        pendingImageFetch: { attachmentId: string };
        messages: ToolMessage[];
      };
      expect(update.pendingImageFetch).to.deep.equal({ attachmentId: 'attachment-1' });
      expect(update.messages[0]?.tool_call_id).to.equal('call-1');
      expect(update.messages[0]?.content).to.include('attached to your next message');
    });

    it('returns a plain refusal ToolMessage, no Command, when the model is not vision-capable', async () => {
      storeBinaryToolContent('thread-bin2', 'key-3', 'attachment-2');
      const middleware = createBinaryContentFetchMiddleware(async () => false);
      const handler = async () => {
        throw new Error('the real tool handler must not be called for a binary entry');
      };

      const result = await middleware.wrapToolCall!(
        fakeToolCallRequest(
          { threadId: 'thread-bin2', toolKey: 'key-3' },
          fakeRuntime({ provider: 'openai', model: 'gpt-text-only' }),
        ),
        handler,
      );

      expect(result).to.not.be.instanceOf(Command);
      expect((result as ToolMessage).content).to.include('does not support image input');
    });

    it('records an attachment observability span when a traceId is present', async () => {
      const obsDir = mkdtempSync(join(tmpdir(), 'binary-content-fetch-obs-'));
      try {
        bootObservability(openDatabase(join(obsDir, 'test.db')));
        const traceId = getObservabilityStore().startTrace({ provider: 'ollama', model: 'llava' });
        const attachmentId = await storeArtifact({
          mimeType: 'image/png',
          original: Buffer.from('fake-bytes'),
          displayFilename: 'rack.png',
          requiresVision: true,
        });
        storeBinaryToolContent('thread-span', 'key-4', attachmentId);
        const middleware = createBinaryContentFetchMiddleware(async () => true);

        await middleware.wrapToolCall!(
          fakeToolCallRequest(
            { threadId: 'thread-span', toolKey: 'key-4' },
            fakeRuntime({ provider: 'ollama', model: 'llava', traceId }),
          ),
          async () => {
            throw new Error('must not reach the real tool');
          },
        );

        const trace = getObservabilityStore().getTrace(traceId);
        const attachmentSpans = trace?.spans.filter((s) => s.type === 'attachment') ?? [];
        expect(attachmentSpans).to.have.length(1);
        expect(attachmentSpans[0]?.name).to.equal('attachment-included');
        expect(JSON.parse(attachmentSpans[0]!.outputPreview!)).to.deep.include({
          artifactId: attachmentId,
          filename: 'rack.png',
          mimeType: 'image/png',
        });
      } finally {
        rmSync(obsDir, { recursive: true, force: true });
      }
    });
  });

  describe('beforeModel [unit]', () => {
    function callBeforeModel(
      middleware: ReturnType<typeof createBinaryContentFetchMiddleware>,
      state: { messages: BaseMessage[]; pendingImageFetch: { attachmentId: string } | null },
    ) {
      const hook = middleware.beforeModel;
      if (typeof hook !== 'function') throw new Error('test setup error: no beforeModel hook');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return hook(state as any, {} as any) as Promise<
        { messages: BaseMessage[]; pendingImageFetch: null } | undefined
      >;
    }

    it('no-ops when there is no pending image fetch', async () => {
      const middleware = createBinaryContentFetchMiddleware();
      const result = await callBeforeModel(middleware, {
        messages: [new HumanMessage('hi')],
        pendingImageFetch: null,
      });

      expect(result).to.equal(undefined);
    });

    it('appends the real image and clears pendingImageFetch when the artifact exists', async () => {
      const original = Buffer.from('fake-image-bytes');
      const attachmentId = await storeArtifact({
        mimeType: 'image/png',
        original,
        displayFilename: 'rack.png',
        requiresVision: true,
      });
      const middleware = createBinaryContentFetchMiddleware();
      const existing = new HumanMessage('look at that photo again');

      const result = await callBeforeModel(middleware, {
        messages: [existing],
        pendingImageFetch: { attachmentId },
      });

      expect(result!.pendingImageFetch).to.equal(null);
      expect(result!.messages).to.have.length(2);
      expect(result!.messages[0]).to.equal(existing);
      expect(result!.messages[1]!.content).to.deep.equal([
        { type: 'text', text: 'Here is the image you asked to see again:' },
        { type: 'image', mimeType: 'image/png', data: original.toString('base64') },
      ]);
    });

    it('appends a plain-text fallback and clears pendingImageFetch when the artifact bytes are gone', async () => {
      const attachmentId = await storeArtifact({
        mimeType: 'image/png',
        original: Buffer.from('fake-image-bytes'),
        displayFilename: 'rack.png',
        requiresVision: true,
      });
      const meta = getArtifactMeta(attachmentId)!;
      unlinkSync(join(dir, attachmentId, meta.originalFilename));
      const middleware = createBinaryContentFetchMiddleware();

      const result = await callBeforeModel(middleware, {
        messages: [new HumanMessage('look again')],
        pendingImageFetch: { attachmentId },
      });

      expect(result!.pendingImageFetch).to.equal(null);
      expect(result!.messages[1]!.content).to.include('no longer available');
    });
  });

  // Replays a fixed script of AI turns, one per model call — same pattern as
  // complete-task.tool.integration.test.ts. First turn calls get_tool_key,
  // second turn is the final plain-text reply.
  class ScriptedChatModel extends BaseChatModel {
    private _callIndex = 0;

    constructor(private readonly toolArgs: Record<string, unknown>) {
      super({});
    }

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
              tool_calls: [{ id: 'call_1', name: 'get_tool_key', args: this.toolArgs }],
            })
          : new AIMessage({ content: 'Here is what I see in the photo.' });
      return { generations: [{ message: msg, text: '' }] };
    }
  }

  describe('orchestration — real createAgent graph [orchestration]', () => {
    it('bypasses the real get_tool_key body and injects the real image for a vision-capable model', async () => {
      const original = Buffer.from('a real png worth of bytes');
      const attachmentId = await storeArtifact({
        mimeType: 'image/png',
        original,
        displayFilename: 'rack.png',
        requiresVision: true,
      });
      const threadId = 'orchestration-thread-1';
      const toolKey = 'orch-key-1';
      storeBinaryToolContent(threadId, toolKey, attachmentId);

      const agent = createAgent({
        model: new ScriptedChatModel({ threadId, toolKey }),
        tools: [getToolKeyTool],
        middleware: [createBinaryContentFetchMiddleware(async () => true)] as const,
      });

      const final = await agent.invoke({
        messages: [new HumanMessage('look at that photo again')],
      });

      // The real get-tool-key.tool.ts body would have returned a "not
      // found" message (getToolContent returns undefined for a binary
      // entry) — seeing the middleware's own confirmation text on the
      // get_tool_key ToolMessage in the real final state instead proves
      // wrapToolCall actually short-circuited the real tool body, in a real
      // LangGraph run (not just a direct hook call).
      const toolMessage = final.messages.find(
        (m: BaseMessage) => m.getType() === 'tool',
      ) as ToolMessage;
      expect(String(toolMessage.content)).to.include('attached to your next message');
      expect(String(toolMessage.content)).to.not.include('KV content not found');

      const imageMessage = final.messages.find(
        (m: BaseMessage) =>
          Array.isArray(m.content) &&
          m.content.some(
            (block) =>
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'image',
          ),
      );
      expect(imageMessage, 'final message list must contain the re-attached image').to.not.equal(
        undefined,
      );
      expect(imageMessage!.content).to.deep.include({
        type: 'image',
        mimeType: 'image/png',
        data: original.toString('base64'),
      });
    });

    it('refuses plainly and injects nothing when the model is not vision-capable', async () => {
      const attachmentId = await storeArtifact({
        mimeType: 'image/png',
        original: Buffer.from('bytes'),
        displayFilename: 'rack2.png',
        requiresVision: true,
      });
      const threadId = 'orchestration-thread-2';
      const toolKey = 'orch-key-2';
      storeBinaryToolContent(threadId, toolKey, attachmentId);

      const agent = createAgent({
        model: new ScriptedChatModel({ threadId, toolKey }),
        tools: [getToolKeyTool],
        middleware: [createBinaryContentFetchMiddleware(async () => false)] as const,
      });

      const final = await agent.invoke({
        messages: [new HumanMessage('look at that photo again')],
      });
      const hasImage = final.messages.some(
        (m: BaseMessage) =>
          Array.isArray(m.content) &&
          m.content.some(
            (block) =>
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'image',
          ),
      );
      expect(hasImage).to.equal(false);
      const toolMessage = final.messages.find(
        (m: BaseMessage) => m.getType() === 'tool',
      ) as ToolMessage;
      expect(String(toolMessage.content)).to.include('does not support image input');
    });
  });
});
