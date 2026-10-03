import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { getFailureCategory } from '../../src/failure-category.js';
import type { ScenarioResultDetails } from '../../src/schemas.js';

describe('getFailureCategory', () => {
  it('reports malformed_tool_call for a tool-call result with malformedToolCall set [unit]', () => {
    const details: ScenarioResultDetails = {
      type: 'tool-call',
      expectedTool: 'wiki_search',
      toolCalled: null,
      fieldResults: [],
      score: 0,
      malformedToolCall: { parsedToolName: 'wiki_search', raw: '<tool_call>...' },
    };
    assert.equal(getFailureCategory(details), 'malformed_tool_call');
  });

  it('reports malformed_tool_call for a tool-sequence result with malformedToolCall set [unit]', () => {
    const details: ScenarioResultDetails = {
      type: 'tool-sequence',
      expectedTool: 'wiki_search',
      toolCalled: null,
      fieldResults: [],
      score: 0,
      malformedToolCall: { parsedToolName: null, raw: '<tool_call>...' },
    };
    assert.equal(getFailureCategory(details), 'malformed_tool_call');
  });

  it('reports malformed_tool_call for an llm-judge result with malformedToolCall set [unit]', () => {
    const details: ScenarioResultDetails = {
      type: 'llm-judge',
      score: 2,
      reasoning: 'The reply was a raw tool call block, not a real answer.',
      judgeModel: 'test-model',
      biasRisk: false,
      malformedToolCall: { parsedToolName: 'wiki_locate', raw: '<tool_call>...' },
    };
    assert.equal(getFailureCategory(details), 'malformed_tool_call');
  });

  it('reports prose_question for a tool-call result with proseQuestion set [unit]', () => {
    const details: ScenarioResultDetails = {
      type: 'tool-call',
      expectedTool: 'ask_user',
      toolCalled: null,
      fieldResults: [],
      score: 0,
      proseQuestion: { raw: 'Did you mean personal or work?' },
    };
    assert.equal(getFailureCategory(details), 'prose_question');
  });

  it('reports prose_question for a tool-sequence result with proseQuestion set [unit]', () => {
    const details: ScenarioResultDetails = {
      type: 'tool-sequence',
      expectedTool: 'ask_user',
      toolCalled: null,
      fieldResults: [],
      score: 0,
      proseQuestion: { raw: 'Did you mean personal or work?' },
    };
    assert.equal(getFailureCategory(details), 'prose_question');
  });

  it('prefers malformed_tool_call when both fields happen to be set [unit]', () => {
    const details: ScenarioResultDetails = {
      type: 'tool-call',
      expectedTool: 'ask_user',
      toolCalled: null,
      fieldResults: [],
      score: 0,
      malformedToolCall: { parsedToolName: 'ask_user', raw: '<tool_call>...' },
      proseQuestion: { raw: 'Did you mean personal or work?' },
    };
    assert.equal(getFailureCategory(details), 'malformed_tool_call');
  });

  it('returns null for a tool-call result with neither field set [unit]', () => {
    const details: ScenarioResultDetails = {
      type: 'tool-call',
      expectedTool: 'wiki_search',
      toolCalled: 'wiki_search',
      fieldResults: [],
      score: 1,
    };
    assert.equal(getFailureCategory(details), null);
  });

  it('returns null for a details type that declares neither field, e.g. deterministic [unit]', () => {
    const details: ScenarioResultDetails = {
      type: 'deterministic',
      match: 'contains',
      expected: 'hello',
      passed: true,
    };
    assert.equal(getFailureCategory(details), null);
  });

  it('returns null for a skipped result [unit]', () => {
    const details: ScenarioResultDetails = { type: 'skipped' };
    assert.equal(getFailureCategory(details), null);
  });
});
