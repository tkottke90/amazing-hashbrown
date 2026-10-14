import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { parse } from 'yaml';
import type { TraceWithSpans, SpanRecord } from '@tkottke90/llm-common-types/traces';
import {
  buildScenarioSource,
  buildScenarioDraft,
  formatSuiteYamlBlock,
  type ScenarioSourceMessage,
  type ScenarioSource,
  type ScenarioToolTurnSeed,
} from '../../src/trace-scenario-source.js';

function makeTrace(overrides: Partial<TraceWithSpans> = {}): TraceWithSpans {
  return {
    traceId: 'trace-1',
    threadId: 'thread-1',
    taskId: null,
    provider: 'local',
    model: 'llama3.2',
    source: 'chat',
    startedAt: '2026-10-14T12:00:00.000Z',
    endedAt: '2026-10-14T12:00:05.000Z',
    totalTokens: 100,
    totalCostEstimate: null,
    systemPrompt: null,
    tools: null,
    error: null,
    spans: [],
    ...overrides,
  };
}

function makeSpan(overrides: Partial<SpanRecord>): SpanRecord {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    parentSpanId: null,
    type: 'llm-call',
    name: 'llama3.2',
    startedAt: '2026-10-14T12:00:00.100Z',
    endedAt: '2026-10-14T12:00:01.000Z',
    latencyMs: 900,
    inputTokens: 10,
    outputTokens: 10,
    outputPreview: null,
    inputPreview: null,
    error: null,
    ...overrides,
  };
}

function userMessage(seq: number, content: string, sentAt: string): ScenarioSourceMessage {
  return { kind: 'user', seq, payload: { content, sentAt } };
}

function toolCallMessage(
  seq: number,
  toolName: string,
  inputs: unknown,
  outputs?: unknown,
): ScenarioSourceMessage {
  return {
    kind: 'tool_call',
    seq,
    payload: {
      toolCallId: `tc-${seq}`,
      toolName,
      inputs,
      ...(outputs !== undefined ? { outputs } : {}),
    },
  };
}

describe('buildScenarioSource', () => {
  it('seeds just the opening user turn when the trace made no tool calls [unit]', () => {
    const trace = makeTrace({
      spans: [makeSpan({ type: 'llm-call', outputPreview: 'Sure, here you go.' })],
    });
    const messages = [userMessage(1, 'What time is it?', '2026-10-14T11:59:59.000Z')];

    const result = buildScenarioSource(trace, messages);

    assert.deepEqual(result.turns, [{ user: 'What time is it?' }]);
    assert.equal(result.finalAssistantText, 'Sure, here you go.');
    assert.equal(result.finalToolCall, null);
    assert.equal(result.incomplete, false);
  });

  it('captures several tool calls in a row, matched by name and order, not by id [unit]', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ spanId: 'llm-1', type: 'llm-call', outputPreview: '[{"name":"wiki_search"}]' }),
        makeSpan({
          spanId: 'tool-1',
          type: 'tool-call',
          name: 'wiki_search',
          inputPreview: '{"query":"deploy steps"}',
          outputPreview: '(truncated)',
        }),
        makeSpan({ spanId: 'llm-2', type: 'llm-call', outputPreview: '[{"name":"wiki_search"}]' }),
        makeSpan({
          spanId: 'tool-2',
          type: 'tool-call',
          name: 'wiki_search',
          inputPreview: '{"query":"deploy steps v2"}',
          outputPreview: '(truncated)',
        }),
        makeSpan({ spanId: 'llm-3', type: 'llm-call', outputPreview: 'Done.' }),
      ],
    });
    // Thread messages use LangGraph tool_call ids, unrelated to the spans'
    // LangChain runIds above — matching must happen by name/order, not id.
    const messages = [
      userMessage(1, 'Find the deploy steps', '2026-10-14T11:59:59.000Z'),
      toolCallMessage(2, 'wiki_search', { query: 'deploy steps' }, { results: [] }),
      toolCallMessage(
        3,
        'wiki_search',
        { query: 'deploy steps v2' },
        { results: ['Deploy Notes'] },
      ),
    ];

    const result = buildScenarioSource(trace, messages);

    assert.deepEqual(result.turns, [
      { user: 'Find the deploy steps' },
      { tool: 'wiki_search', args: { query: 'deploy steps' }, result: { results: [] } },
      {
        tool: 'wiki_search',
        args: { query: 'deploy steps v2' },
        result: { results: ['Deploy Notes'] },
      },
    ]);
    assert.equal(result.finalAssistantText, 'Done.');
    assert.equal(result.incomplete, false);
  });

  it('falls back to the trace preview and flags incomplete when no thread message matches a tool call [unit]', () => {
    const trace = makeTrace({
      threadId: null,
      spans: [
        makeSpan({ type: 'llm-call', outputPreview: '[{"name":"shell_exec"}]' }),
        makeSpan({
          type: 'tool-call',
          name: 'shell_exec',
          inputPreview: '{"command":"ls"}',
          outputPreview: 'file1\nfile2',
        }),
      ],
    });

    const result = buildScenarioSource(trace, []);

    const toolTurn = result.turns[1] as ScenarioToolTurnSeed;
    assert.equal(toolTurn.tool, 'shell_exec');
    assert.deepEqual(toolTurn.args, { command: 'ls' });
    assert.deepEqual(toolTurn.result, { value: 'file1\nfile2' });
    assert.equal(result.incomplete, true);
    assert.match(result.incompleteReason ?? '', /no matching thread message/);
  });

  it('falls back to the span error when a tool call never finalized in the thread [unit]', () => {
    const trace = makeTrace({
      spans: [
        makeSpan({ type: 'llm-call', outputPreview: '[{"name":"web_fetch"}]' }),
        makeSpan({
          type: 'tool-call',
          name: 'web_fetch',
          inputPreview: '{"url":"https://example.com"}',
          outputPreview: null,
          error: 'fetch timed out after 10s',
        }),
      ],
    });
    // Recorded but never finalized — no `outputs` field (see
    // thread-message-writer.ts's recordToolCallStart vs. finalizeToolCall).
    const messages = [
      userMessage(1, 'Summarize example.com', '2026-10-14T11:59:59.000Z'),
      toolCallMessage(2, 'web_fetch', { url: 'https://example.com' }),
    ];

    const result = buildScenarioSource(trace, messages);

    const toolTurn = result.turns[1] as ScenarioToolTurnSeed;
    assert.deepEqual(toolTurn.result, { value: 'fetch timed out after 10s' });
    assert.equal(result.incomplete, true);
    assert.match(result.incompleteReason ?? '', /errored/);
  });

  it('seeds a TODO user turn and flags incomplete when no user message exists [unit]', () => {
    const trace = makeTrace({ threadId: null, spans: [makeSpan({ outputPreview: 'Hi.' })] });

    const result = buildScenarioSource(trace, []);

    assert.deepEqual(result.turns, [{ user: 'TODO - no user message found for this trace' }]);
    assert.equal(result.incomplete, true);
    assert.match(result.incompleteReason ?? '', /no user message found/);
  });
});

describe('buildScenarioDraft', () => {
  const baseSource: ScenarioSource = {
    traceId: 'trace-1',
    threadId: 'thread-1',
    source: 'task-run',
    provider: 'local',
    model: 'llama3.2',
    error: null,
    turns: [{ user: 'Find the deploy steps' }, { tool: 'wiki_search', args: {}, result: {} }],
    finalToolCall: { name: 'wiki_search', args: { query: 'retry' } },
    finalAssistantText: null,
    incomplete: false,
  };

  it('builds a tool-sequence scenario when the source has tool turns [unit]', () => {
    const draft = buildScenarioDraft(baseSource, { id: 'bug-42-recursion-loop' });

    assert.equal(draft.type, 'tool-sequence');
    assert.equal(draft.id, 'bug-42-recursion-loop');
    if (draft.type === 'tool-sequence') {
      assert.deepEqual(draft.turns, baseSource.turns);
      assert.equal(draft.tool, 'wiki_search');
    }
  });

  it('builds an llm-judge scenario with a flat input when there were no tool turns [unit]', () => {
    const source: ScenarioSource = {
      ...baseSource,
      turns: [{ user: 'What time is it?' }],
      finalToolCall: null,
      finalAssistantText: 'Sure, here you go.',
    };

    const draft = buildScenarioDraft(source);

    assert.equal(draft.type, 'llm-judge');
    if (draft.type === 'llm-judge') {
      assert.equal(draft.input, 'What time is it?');
      assert.match(draft.rubric, /TODO/);
    }
  });

  it('notes the incomplete reason in the purpose field so a reviewer sees it [unit]', () => {
    const source: ScenarioSource = {
      ...baseSource,
      incomplete: true,
      incompleteReason: 'no matching thread message found for tool call "wiki_search"',
    };

    const draft = buildScenarioDraft(source);

    assert.match(draft.purpose, /incomplete/);
    assert.match(draft.purpose, /no matching thread message/);
  });
});

describe('formatSuiteYamlBlock', () => {
  it('indents every line by two spaces so it nests under an existing scenarios: list [unit]', () => {
    const draft = buildScenarioDraft({
      traceId: 'trace-1',
      threadId: null,
      source: 'chat',
      provider: 'local',
      model: 'llama3.2',
      error: null,
      turns: [{ user: 'hello' }],
      finalToolCall: null,
      finalAssistantText: 'hi',
      incomplete: false,
    });

    const block = formatSuiteYamlBlock(draft);

    assert.ok(block.startsWith('\n'));
    for (const line of block.split('\n').slice(1)) {
      if (line.length > 0) assert.ok(line.startsWith('  '));
    }
  });

  it('produces valid, re-parseable YAML round-tripping the same scenario [unit]', () => {
    const draft = buildScenarioDraft({
      traceId: 'trace-1',
      threadId: null,
      source: 'chat',
      provider: 'local',
      model: 'llama3.2',
      error: null,
      turns: [{ user: 'hello' }],
      finalToolCall: null,
      finalAssistantText: 'hi',
      incomplete: false,
    });

    const block = formatSuiteYamlBlock(draft);
    const dedented = block
      .split('\n')
      .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
      .join('\n');
    const [reparsed] = parse(dedented) as [Record<string, unknown>];

    assert.equal(reparsed.id, draft.id);
    assert.equal(reparsed.type, draft.type);
  });
});
