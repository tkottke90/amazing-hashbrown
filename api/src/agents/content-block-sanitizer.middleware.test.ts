import { describe, it } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import { createContentBlockSanitizerMiddleware } from './content-block-sanitizer.middleware.js';

function makeState(messages: BaseMessage[]): { messages: BaseMessage[] } {
  return { messages };
}

function makeRuntime(threadId?: string) {
  return { configurable: threadId ? { thread_id: threadId } : {} };
}

interface BeforeModelResult {
  messages: BaseMessage[];
}

async function callBeforeModel(
  middleware: ReturnType<typeof createContentBlockSanitizerMiddleware>,
  state: { messages: BaseMessage[] },
  runtime: ReturnType<typeof makeRuntime>,
): Promise<BeforeModelResult | undefined> {
  const hook = middleware.beforeModel;
  if (typeof hook !== 'function') throw new Error('test setup error: no beforeModel hook');
  return hook(state, runtime) as Promise<BeforeModelResult | undefined>;
}

describe('agents/content-block-sanitizer.middleware [unit]', () => {
  it('strips a leaked input_json_delta block while leaving the rest of the content untouched', async () => {
    const middleware = createContentBlockSanitizerMiddleware();
    const message = new AIMessage({
      content: [
        { index: 0, type: 'tool_use', id: 'toolu_test', name: 'wiki_lint', input: '' },
        { index: 0, input: '{"wikiId":"user"}', type: 'input_json_delta' },
      ],
    });
    const result = await callBeforeModel(middleware, makeState([message]), makeRuntime('thread-1'));

    expect(result).to.not.equal(undefined);
    expect(result!.messages[0]!.content).to.deep.equal([
      { index: 0, type: 'tool_use', id: 'toolu_test', name: 'wiki_lint', input: '' },
    ]);
  });

  it('strips every type of leaked streaming-delta block (text_delta, thinking_delta, citations_delta, signature_delta)', async () => {
    const middleware = createContentBlockSanitizerMiddleware();
    const message = new AIMessage({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text_delta', text: 'leaked' },
        { type: 'thinking_delta', thinking: 'leaked' },
        { type: 'citations_delta', citation: {} },
        { type: 'signature_delta', signature: 'leaked' },
      ],
    });
    const result = await callBeforeModel(middleware, makeState([message]), makeRuntime('thread-1'));

    expect(result!.messages[0]!.content).to.deep.equal([{ type: 'text', text: 'hello' }]);
  });

  it('leaves legitimate settled block types (tool_use, thinking, text) completely unchanged', async () => {
    const middleware = createContentBlockSanitizerMiddleware();
    const content = [
      { type: 'text', text: 'here is my plan' },
      { type: 'thinking', thinking: 'reasoning about it' },
      { type: 'tool_use', id: 'toolu_1', name: 'wiki_orient', input: { wikiId: 'user' } },
    ];
    const message = new AIMessage({ content });
    const result = await callBeforeModel(middleware, makeState([message]), makeRuntime('thread-1'));

    expect(result).to.equal(undefined);
    expect(message.content).to.deep.equal(content);
  });

  it('leaves a message with plain string content untouched', async () => {
    const middleware = createContentBlockSanitizerMiddleware();
    const message = new AIMessage('a plain text reply');
    const result = await callBeforeModel(middleware, makeState([message]), makeRuntime('thread-1'));

    expect(result).to.equal(undefined);
    expect(message.content).to.equal('a plain text reply');
  });

  it('returns undefined (no-op) when nothing needs stripping across any message', async () => {
    const middleware = createContentBlockSanitizerMiddleware();
    const result = await callBeforeModel(
      middleware,
      makeState([new HumanMessage('hi'), new AIMessage('hello back')]),
      makeRuntime('thread-1'),
    );

    expect(result).to.equal(undefined);
  });

  it('only inspects AIMessages — a non-AI message carrying a "_delta"-suffixed block is left alone', async () => {
    const middleware = createContentBlockSanitizerMiddleware();
    const human = new HumanMessage({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'some_delta', value: 'not ours to touch' },
      ],
    });
    const result = await callBeforeModel(middleware, makeState([human]), makeRuntime('thread-1'));

    expect(result).to.equal(undefined);
    expect(human.content).to.deep.equal([
      { type: 'text', text: 'hi' },
      { type: 'some_delta', value: 'not ours to touch' },
    ]);
  });

  it('fixes only the affected message when several messages are present, leaving the others as the same references', async () => {
    const middleware = createContentBlockSanitizerMiddleware();
    const human = new HumanMessage('question');
    const clean = new AIMessage({ content: [{ type: 'text', text: 'fine' }] });
    const dirty = new AIMessage({
      content: [
        { index: 0, type: 'tool_use', id: 'toolu_2', name: 'wiki_lint', input: '' },
        { index: 0, input: '{}', type: 'input_json_delta' },
      ],
    });
    const result = await callBeforeModel(
      middleware,
      makeState([human, clean, dirty]),
      makeRuntime('thread-1'),
    );

    expect(result).to.not.equal(undefined);
    expect(result!.messages[0]).to.equal(human);
    expect(result!.messages[1]).to.equal(clean);
    expect(result!.messages[2]!.content).to.deep.equal([
      { index: 0, type: 'tool_use', id: 'toolu_2', name: 'wiki_lint', input: '' },
    ]);
  });
});
