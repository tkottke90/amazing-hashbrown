import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { buildSeededMessages, withSystemPrompt, extractToolCallData } from '../../src/runner.js';

describe('buildSeededMessages', () => {
  it('starts with a HumanMessage carrying the input', () => {
    const messages = buildSeededMessages('generate a dragon', [
      { tool: 'generate_image', args: { prompt: 'a dragon' }, result: { imageBase64: 'abc' } },
    ]);
    assert.ok(messages[0] instanceof HumanMessage);
    assert.equal(messages[0].content, 'generate a dragon');
  });

  it('appends one AIMessage(tool_call) + ToolMessage(result) pair per prior turn', () => {
    const messages = buildSeededMessages('x', [
      { tool: 'generate_image', args: { prompt: 'a dragon' }, result: { imageBase64: 'abc' } },
    ]);

    assert.equal(messages.length, 3);

    const ai = messages[1];
    assert.ok(ai instanceof AIMessage);
    assert.equal(ai.tool_calls?.length, 1);
    assert.equal(ai.tool_calls?.[0]?.name, 'generate_image');
    assert.deepEqual(ai.tool_calls?.[0]?.args, { prompt: 'a dragon' });
    const toolCallId = ai.tool_calls?.[0]?.id;
    assert.ok(toolCallId);

    const toolMsg = messages[2];
    assert.ok(toolMsg instanceof ToolMessage);
    assert.equal(toolMsg.tool_call_id, toolCallId);
    assert.equal(toolMsg.content, JSON.stringify({ imageBase64: 'abc' }));
  });

  it('chains multiple prior turns in order, each with a distinct tool_call_id', () => {
    const messages = buildSeededMessages('x', [
      { tool: 'tool_a', args: { a: 1 }, result: { out: 'a' } },
      { tool: 'tool_b', args: { b: 2 }, result: { out: 'b' } },
    ]);

    // Human, AI(a), Tool(a), AI(b), Tool(b)
    assert.equal(messages.length, 5);

    const aiA = messages[1] as AIMessage;
    const toolA = messages[2] as ToolMessage;
    const aiB = messages[3] as AIMessage;
    const toolB = messages[4] as ToolMessage;

    assert.equal(aiA.tool_calls?.[0]?.name, 'tool_a');
    assert.equal(toolA.tool_call_id, aiA.tool_calls?.[0]?.id);
    assert.equal(toolA.content, JSON.stringify({ out: 'a' }));

    assert.equal(aiB.tool_calls?.[0]?.name, 'tool_b');
    assert.equal(toolB.tool_call_id, aiB.tool_calls?.[0]?.id);
    assert.equal(toolB.content, JSON.stringify({ out: 'b' }));

    assert.notEqual(aiA.tool_calls?.[0]?.id, aiB.tool_calls?.[0]?.id);
  });
});

describe('withSystemPrompt', () => {
  it('returns string input unchanged when no systemPrompt is given', () => {
    const result = withSystemPrompt('hello');
    assert.equal(result, 'hello');
  });

  it('returns message-array input unchanged when no systemPrompt is given', () => {
    const messages = buildSeededMessages('x', [{ tool: 'tool_a', args: {}, result: { out: 'a' } }]);
    assert.equal(withSystemPrompt(messages), messages);
  });

  it('wraps string input in a SystemMessage + HumanMessage pair when systemPrompt is given', () => {
    const result = withSystemPrompt('hello', 'be nice');
    assert.ok(Array.isArray(result));
    const [sys, human] = result as [SystemMessage, HumanMessage];
    assert.ok(sys instanceof SystemMessage);
    assert.equal(sys.content, 'be nice');
    assert.ok(human instanceof HumanMessage);
    assert.equal(human.content, 'hello');
  });

  it('prepends a SystemMessage ahead of existing messages when systemPrompt is given', () => {
    const messages = buildSeededMessages('x', [{ tool: 'tool_a', args: {}, result: { out: 'a' } }]);
    const result = withSystemPrompt(messages, 'be nice') as (typeof messages)[number][];
    assert.equal(result.length, messages.length + 1);
    assert.ok(result[0] instanceof SystemMessage);
    assert.equal(result[0].content, 'be nice');
    assert.deepEqual(result.slice(1), messages);
  });
});

describe('extractToolCallData', () => {
  it('maps tool_calls into toolCalls, leaving invalidToolCalls empty', () => {
    const response = new AIMessage({
      content: '',
      tool_calls: [{ id: '1', name: 'wiki_search', args: { query: 'x' } }],
    });
    const result = extractToolCallData(response);
    assert.deepEqual(result.toolCalls, [{ name: 'wiki_search', args: { query: 'x' } }]);
    assert.deepEqual(result.invalidToolCalls, []);
  });

  it('maps invalid_tool_calls, preserving name/args/error, when tool_calls is empty', () => {
    const response = new AIMessage({
      content: '',
      invalid_tool_calls: [
        { name: 'wiki_search', args: '{bad json', error: 'failed to parse arguments' },
      ],
    });
    const result = extractToolCallData(response);
    assert.deepEqual(result.toolCalls, []);
    assert.deepEqual(result.invalidToolCalls, [
      { name: 'wiki_search', args: '{bad json', error: 'failed to parse arguments' },
    ]);
  });

  it('passes through a non-empty response_metadata as responseMetadata', () => {
    const response = new AIMessage({
      content: '',
      response_metadata: { done_reason: 'stop' },
    });
    const result = extractToolCallData(response);
    assert.deepEqual(result.responseMetadata, { done_reason: 'stop' });
  });

  it('returns undefined responseMetadata for an empty response_metadata object', () => {
    const response = new AIMessage({ content: '', response_metadata: {} });
    const result = extractToolCallData(response);
    assert.equal(result.responseMetadata, undefined);
  });

  it('still extracts content correctly alongside the new fields', () => {
    const response = new AIMessage({ content: 'hello there' });
    const result = extractToolCallData(response);
    assert.equal(result.content, 'hello there');
  });

  it('captures additional_kwargs.reasoning_content as reasoningContent', () => {
    const response = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: 'the model thinking out loud' },
    });
    const result = extractToolCallData(response);
    assert.equal(result.reasoningContent, 'the model thinking out loud');
  });

  it('returns undefined reasoningContent when additional_kwargs has no reasoning_content', () => {
    const response = new AIMessage({ content: '', additional_kwargs: {} });
    const result = extractToolCallData(response);
    assert.equal(result.reasoningContent, undefined);
  });

  it('returns undefined reasoningContent for an empty reasoning_content string', () => {
    const response = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: '' },
    });
    const result = extractToolCallData(response);
    assert.equal(result.reasoningContent, undefined);
  });
});
