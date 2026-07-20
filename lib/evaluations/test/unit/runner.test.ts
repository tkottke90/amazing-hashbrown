import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { buildSeededMessages } from '../../src/runner.js';

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
