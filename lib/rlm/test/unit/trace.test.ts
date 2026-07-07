import { describe, it } from 'mocha';
import { expect } from 'chai';
import { RLMRunner } from '../../src/runner.js';
import { formatTrace, deriveSourcesUsed, deriveMetrics } from '../../src/trace.js';
import type {
  InferenceAdapter,
  InferenceResponse,
  BaseCompleteOptions,
  Message,
  RLMConfig,
  RLMCorpus,
  RLMEvent,
  RLMLogger,
  RLMTrace,
  CorpusMeta,
} from '../../src/types.js';

function base(): InferenceResponse {
  return { message: { role: 'assistant', content: '' } };
}

function scripted(steps: Partial<InferenceResponse>[]): InferenceAdapter {
  let i = 0;
  return {
    async invoke(_m: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse> {
      if (!options?.tools || options.tools.length === 0) return { message: { role: 'assistant', content: 'Synthesized.' } };
      if (i < steps.length) return { ...base(), ...steps[i++] };
      return { message: { role: 'assistant', content: 'Fallback.' } };
    },
  };
}

const CORPUS_TEXT = [
  '# Test Wiki',
  '',
  '## People',
  'Alice is the project lead.',
  'Bob is the architect.',
  '',
  '## Projects',
  'Project Alpha is in progress.',
  'Project Beta launches Q3.',
].join('\n');

const corpus: RLMCorpus = { text: CORPUS_TEXT, source: 'test-wiki' };

const baseConfig: Partial<RLMConfig> = {
  model: 'test',
  maxIterations: 10,
  maxResultTokens: 2000,
  maxSliceLines: 200,
  think: false,
  traceDetail: 'full',
};

// --------------------------------------------------------------------------
// RLMLogger / event stream
// --------------------------------------------------------------------------

describe('RLMLogger', () => {
  it('onEvent is called for each event in order', async () => {
    const received: string[] = [];
    const logger: RLMLogger = {
      onEvent(e) {
        received.push(e.kind);
      },
    };

    const adapter = scripted([
      { toolCalls: [{ name: 'peek', arguments: { chars: 100 } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'Alice.' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('Who is the project lead?', corpus);

    expect(received).to.include('run_started');
    expect(received).to.include('model_requested');
    expect(received).to.include('model_responded');
    expect(received).to.include('tool_dispatched');
    expect(received).to.include('tool_completed');
    expect(received).to.include('run_completed');
  });

  it('onTrace is called exactly once at completion', async () => {
    const traces: RLMTrace[] = [];
    const logger: RLMLogger = {
      onTrace(t) {
        traces.push(t);
      },
    };

    const adapter = scripted([
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'Done.' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('Quick?', corpus);

    expect(traces).to.have.length(1);
    expect(traces[0]!.traceId).to.be.a('string').with.length.greaterThan(0);
    expect(traces[0]!.query).to.equal('Quick?');
    expect(traces[0]!.result.terminationReason).to.equal('final_tool');
  });

  it('trace includes systemPrompt, corpusMeta, and config', async () => {
    let captured: RLMTrace | null = null;
    const logger: RLMLogger = {
      onTrace(t) {
        captured = t;
      },
    };

    const adapter = scripted([{ toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] }]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('test', corpus);

    expect(captured).to.not.equal(null);
    expect(captured!.systemPrompt).to.be.a('string').with.length.greaterThan(0);
    expect(captured!.corpusMeta.source).to.equal('test-wiki');
    expect(captured!.corpusMeta.charCount).to.equal(CORPUS_TEXT.length);
    expect(captured!.config.model).to.equal('test');
  });

  it('matched pairs share correlationId', async () => {
    const events: RLMEvent[] = [];
    const logger: RLMLogger = {
      onEvent(e) {
        events.push(e);
      },
    };

    const adapter = scripted([
      { toolCalls: [{ name: 'grep', arguments: { pattern: 'Alice' } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'Alice.' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('Who is Alice?', corpus);

    const dispatched = events.filter((e) => e.kind === 'tool_dispatched');
    const completed = events.filter((e) => e.kind === 'tool_completed');

    expect(dispatched).to.have.length.greaterThan(0);
    expect(completed).to.have.length.greaterThan(0);

    for (const d of dispatched) {
      if (d.kind !== 'tool_dispatched') continue;
      const match = completed.find(
        (c) => c.kind === 'tool_completed' && c.correlationId === d.correlationId,
      );
      expect(match).to.not.equal(undefined);
    }
  });

  it('model_requested includes messages array in full traceDetail', async () => {
    const events: RLMEvent[] = [];
    const logger: RLMLogger = {
      onEvent(e) {
        events.push(e);
      },
    };

    const adapter = scripted([{ toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] }]);

    const runner = new RLMRunner(
      adapter,
      undefined,
      { ...baseConfig, traceDetail: 'full' },
      logger,
    );
    await runner.run('test', corpus);

    const req = events.find((e) => e.kind === 'model_requested');
    expect(req?.kind).to.equal('model_requested');
    if (req?.kind === 'model_requested') {
      expect(req.messages).to.be.an('array').with.length.greaterThan(0);
    }
  });

  it('model_requested omits messages in compact traceDetail', async () => {
    const events: RLMEvent[] = [];
    const logger: RLMLogger = {
      onEvent(e) {
        events.push(e);
      },
    };

    const adapter = scripted([{ toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] }]);

    const runner = new RLMRunner(
      adapter,
      undefined,
      { ...baseConfig, traceDetail: 'compact' },
      logger,
    );
    await runner.run('test', corpus);

    const req = events.find((e) => e.kind === 'model_requested');
    if (req?.kind === 'model_requested') {
      expect(req.messages).to.equal(undefined);
    }
  });
});

// --------------------------------------------------------------------------
// RLMResult — new derived fields
// --------------------------------------------------------------------------

describe('RLMResult derived fields', () => {
  it('events array is populated on the result', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'peek', arguments: { chars: 50 } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'done' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('test', corpus);

    expect(result.events).to.be.an('array').with.length.greaterThan(0);
    expect(result.events.map((e) => e.kind)).to.include('run_started');
    expect(result.events.map((e) => e.kind)).to.include('run_completed');
  });

  it('metrics.peekFirst is true when peek was first tool called', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'peek', arguments: { chars: 100 } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('test', corpus);

    expect(result.metrics.peekFirst).to.equal(true);
  });

  it('metrics.peekFirst is false when grep was first tool called', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'grep', arguments: { pattern: 'Alice' } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('test', corpus);

    expect(result.metrics.peekFirst).to.equal(false);
  });

  it('metrics.toolFrequency counts each retrieval tool', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'grep', arguments: { pattern: 'Alice' } }] },
      { toolCalls: [{ name: 'grep', arguments: { pattern: 'Bob' } }] },
      { toolCalls: [{ name: 'slice', arguments: { startLine: 1, endLine: 3 } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('test', corpus);

    expect(result.metrics.toolFrequency['grep']).to.equal(2);
    expect(result.metrics.toolFrequency['slice']).to.equal(1);
    expect(result.metrics.toolFrequency['final_answer']).to.equal(undefined);
  });

  it('metrics.synthesisTriggered is true when max_iterations fires', async () => {
    const adapter: InferenceAdapter = {
      async invoke(_m: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse> {
        if (!options?.tools || options.tools.length === 0) return { message: { role: 'assistant', content: 'Synthesized.' } };
        return { message: { role: 'assistant', content: '' }, toolCalls: [{ name: 'grep', arguments: { pattern: 'x' } }] };
      },
    };

    const runner = new RLMRunner(adapter, undefined, { ...baseConfig, maxIterations: 3 });
    const result = await runner.run('test', corpus);

    expect(result.metrics.synthesisTriggered).to.equal(true);
    expect(result.terminationReason).to.equal('max_iterations');
  });

  it('sourcesUsed includes slice calls', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'slice', arguments: { startLine: 3, endLine: 5 } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'Alice is lead.' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('Who leads?', corpus);

    const sliceSource = result.sourcesUsed.find((s) => s.tool === 'slice');
    expect(sliceSource).to.not.equal(undefined);
    expect(sliceSource!.startLine).to.equal(3);
    expect(sliceSource!.endLine).to.equal(5);
  });

  it('sourcesUsed includes peek calls', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'peek', arguments: { chars: 120 } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('test', corpus);

    const peekSource = result.sourcesUsed.find((s) => s.tool === 'peek');
    expect(peekSource).to.not.equal(undefined);
    expect(peekSource!.startLine).to.equal(1);
  });
});

// --------------------------------------------------------------------------
// deriveSourcesUsed — standalone unit tests
// --------------------------------------------------------------------------

describe('deriveSourcesUsed', () => {
  it('extracts slice ranges', () => {
    const events: RLMEvent[] = [
      {
        kind: 'tool_dispatched',
        eventId: 'a',
        correlationId: 'c1',
        timestampMs: 0,
        iteration: 1,
        tool: 'slice',
        args: { startLine: 10, endLine: 20 },
        phase: 'reading',
        displayMessage: '',
      },
      {
        kind: 'tool_completed',
        eventId: 'b',
        correlationId: 'c1',
        timestampMs: 1,
        iteration: 1,
        tool: 'slice',
        durationMs: 0,
        result: '',
      },
    ];
    const sources = deriveSourcesUsed(events);
    expect(sources).to.have.length(1);
    expect(sources[0]).to.deep.include({ tool: 'slice', startLine: 10, endLine: 20, iteration: 1 });
  });

  it('extracts summarize ranges', () => {
    const events: RLMEvent[] = [
      {
        kind: 'tool_dispatched',
        eventId: 'a',
        correlationId: 'c2',
        timestampMs: 0,
        iteration: 2,
        tool: 'summarize',
        args: { startLine: 50, endLine: 150, focus: 'deadline' },
        phase: 'summarizing',
        displayMessage: '',
      },
      {
        kind: 'tool_completed',
        eventId: 'b',
        correlationId: 'c2',
        timestampMs: 1,
        iteration: 2,
        tool: 'summarize',
        durationMs: 0,
        result: '',
      },
    ];
    const sources = deriveSourcesUsed(events);
    expect(sources[0]).to.deep.include({ tool: 'summarize', startLine: 50, endLine: 150 });
  });

  it('ignores grep and search (intermediate tools)', () => {
    const events: RLMEvent[] = [
      {
        kind: 'tool_dispatched',
        eventId: 'a',
        correlationId: 'c3',
        timestampMs: 0,
        iteration: 1,
        tool: 'grep',
        args: { pattern: 'foo' },
        phase: 'searching',
        displayMessage: '',
      },
      {
        kind: 'tool_completed',
        eventId: 'b',
        correlationId: 'c3',
        timestampMs: 1,
        iteration: 1,
        tool: 'grep',
        durationMs: 0,
        result: '',
      },
    ];
    const sources = deriveSourcesUsed(events);
    expect(sources).to.have.length(0);
  });
});

// --------------------------------------------------------------------------
// deriveMetrics — standalone unit tests
// --------------------------------------------------------------------------

describe('deriveMetrics', () => {
  const corpusMeta: CorpusMeta = {
    charCount: 1000,
    lineCount: 50,
    hasEmbeddings: false,
    hasProvenance: false,
  };

  it('counts model calls from model_responded events', () => {
    const events: RLMEvent[] = [
      {
        kind: 'model_responded',
        eventId: 'a',
        correlationId: 'c1',
        timestampMs: 0,
        iteration: 1,
        durationMs: 300,
        content: '',
        toolCalls: [],
      },
      {
        kind: 'model_responded',
        eventId: 'b',
        correlationId: 'c2',
        timestampMs: 0,
        iteration: 2,
        durationMs: 250,
        content: '',
        toolCalls: [],
      },
    ];
    const m = deriveMetrics(events, corpusMeta);
    expect(m.modelCallCount).to.equal(2);
    expect(m.totalModelDurationMs).to.equal(550);
  });

  it('identifies peekFirst correctly', () => {
    const events: RLMEvent[] = [
      {
        kind: 'tool_dispatched',
        eventId: 'a',
        correlationId: 'c1',
        timestampMs: 0,
        iteration: 1,
        tool: 'peek',
        args: {},
        phase: 'orientation',
        displayMessage: '',
      },
    ];
    expect(deriveMetrics(events, corpusMeta).peekFirst).to.equal(true);

    const eventsNopeek: RLMEvent[] = [
      {
        kind: 'tool_dispatched',
        eventId: 'b',
        correlationId: 'c2',
        timestampMs: 0,
        iteration: 1,
        tool: 'grep',
        args: {},
        phase: 'searching',
        displayMessage: '',
      },
    ];
    expect(deriveMetrics(eventsNopeek, corpusMeta).peekFirst).to.equal(false);
  });

  it('marks synthesisTriggered from synthesis_triggered event', () => {
    const events: RLMEvent[] = [
      { kind: 'synthesis_triggered', eventId: 'a', correlationId: 'c1', timestampMs: 0 },
    ];
    expect(deriveMetrics(events, corpusMeta).synthesisTriggered).to.equal(true);
    expect(deriveMetrics([], corpusMeta).synthesisTriggered).to.equal(false);
  });
});

// --------------------------------------------------------------------------
// formatTrace
// --------------------------------------------------------------------------

describe('formatTrace', () => {
  it('returns a non-empty string', async () => {
    let captured: RLMTrace | null = null;
    const logger: RLMLogger = {
      onTrace(t) {
        captured = t;
      },
    };

    const adapter = scripted([
      { toolCalls: [{ name: 'grep', arguments: { pattern: 'Alice' } }] },
      { toolCalls: [{ name: 'slice', arguments: { startLine: 4, endLine: 5 } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'Alice is the project lead.' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('Who is the project lead?', corpus);

    const output = formatTrace(captured!);
    expect(output).to.be.a('string').with.length.greaterThan(100);
  });

  it('output contains the query', async () => {
    let captured: RLMTrace | null = null;
    const logger: RLMLogger = {
      onTrace(t) {
        captured = t;
      },
    };

    const adapter = scripted([{ toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] }]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('What is the meaning of life?', corpus);

    const output = formatTrace(captured!);
    expect(output).to.include('What is the meaning of life?');
  });

  it('output contains the corpus source', async () => {
    let captured: RLMTrace | null = null;
    const logger: RLMLogger = {
      onTrace(t) {
        captured = t;
      },
    };

    const adapter = scripted([{ toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] }]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('test', corpus);

    const output = formatTrace(captured!);
    expect(output).to.include('test-wiki');
  });

  it('output contains iteration numbers and tool names', async () => {
    let captured: RLMTrace | null = null;
    const logger: RLMLogger = {
      onTrace(t) {
        captured = t;
      },
    };

    const adapter = scripted([
      { toolCalls: [{ name: 'peek', arguments: { chars: 200 } }] },
      { toolCalls: [{ name: 'grep', arguments: { pattern: 'Alice' } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'Alice leads.' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('Who leads?', corpus);

    const output = formatTrace(captured!);
    expect(output).to.include('[1]');
    expect(output).to.include('[2]');
    expect(output).to.include('peek');
    expect(output).to.include('grep');
  });

  it('output contains final answer', async () => {
    let captured: RLMTrace | null = null;
    const logger: RLMLogger = {
      onTrace(t) {
        captured = t;
      },
    };

    const adapter = scripted([
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'Alice is the project lead.' } }] },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('Who leads?', corpus);

    const output = formatTrace(captured!);
    expect(output).to.include('Alice is the project lead.');
  });

  it('output contains metrics section', async () => {
    let captured: RLMTrace | null = null;
    const logger: RLMLogger = {
      onTrace(t) {
        captured = t;
      },
    };

    const adapter = scripted([{ toolCalls: [{ name: 'final_answer', arguments: { content: 'ok' } }] }]);

    const runner = new RLMRunner(adapter, undefined, baseConfig, logger);
    await runner.run('test', corpus);

    const output = formatTrace(captured!);
    expect(output).to.include('Metrics:');
    expect(output).to.include('model calls:');
    expect(output).to.include('chars read:');
  });
});
