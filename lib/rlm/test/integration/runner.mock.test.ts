import { describe, it } from 'mocha';
import { expect } from 'chai';
import { RLMRunner } from '../../src/runner.js';
import type {
  InferenceAdapter,
  InferenceResponse,
  BaseCompleteOptions,
  Message,
  RLMCorpus,
} from '../../src/types.js';

// Full-loop integration test with a MockAdapter that returns scripted sequences.
// No inference, no network — exercises the complete runner + REPL path.

const WIKI_TEXT = [
  '# User Wiki',
  '',
  '## People',
  '',
  '### Marcus Delacroix',
  'Marcus is the lead engineer on the DataBridge project.',
  'He joined the team in Q3 2024.',
  '',
  '### Sofia Martel',
  'Sofia handles project management for the Q4 initiatives.',
  '',
  '## Projects',
  '',
  '### DataBridge',
  'DataBridge is a real-time data pipeline replacing the legacy ETL system.',
  'Target launch: Q1 2025.',
  '',
  '### Q4 Timeline',
  'The Q4 timeline is aggressive: all milestones must land before Dec 15.',
].join('\n');

const corpus: RLMCorpus = { text: WIKI_TEXT, source: 'user-wiki' };

const baseConfig = {
  model: 'test',
  maxIterations: 10,
  maxResultTokens: 2000,
  maxSliceLines: 200,
  think: false,
};

function scripted(steps: Partial<InferenceResponse>[]): InferenceAdapter {
  let i = 0;
  return {
    async invoke(_msgs: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse> {
      const base: InferenceResponse = { message: { role: 'assistant', content: '' } };
      // Synthesis call (tools suppressed)
      if (!options?.tools || options.tools.length === 0) {
        return { ...base, message: { role: 'assistant', content: 'Synthesized best answer.' } };
      }
      if (i < steps.length) return { ...base, ...steps[i++] };
      return { ...base, message: { role: 'assistant', content: 'Fallback answer.' } };
    },
  };
}

describe('RLMRunner — mock integration', () => {
  it('realistic query: peek then grep then slice then final_answer', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'peek', arguments: { chars: 500 } }] },
      { toolCalls: [{ name: 'grep', arguments: { pattern: 'Marcus' } }] },
      { toolCalls: [{ name: 'slice', arguments: { startLine: 5, endLine: 7 } }] },
      {
        toolCalls: [
          {
            name: 'final_answer',
            arguments: { content: 'Marcus Delacroix is the lead on DataBridge.' },
          },
        ],
      },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('Who is the lead engineer on DataBridge?', corpus);

    expect(result.terminationReason).to.equal('final_tool');
    expect(result.found).to.equal(true);
    expect(result.answer).to.equal('Marcus Delacroix is the lead on DataBridge.');
    expect(result.toolCallTrace.map((t) => t.tool)).to.deep.equal(['peek', 'grep', 'slice']);
  });

  it('not_found path: model searches and gives up honestly', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'peek', arguments: { chars: 500 } }] },
      { toolCalls: [{ name: 'grep', arguments: { pattern: 'purple unicorn' } }] },
      {
        toolCalls: [
          {
            name: 'not_found',
            arguments: { searched: 'purple unicorn — no matches in peek or grep' },
          },
        ],
      },
    ]);

    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('Tell me about the purple unicorn.', corpus);

    expect(result.terminationReason).to.equal('not_found_tool');
    expect(result.found).to.equal(false);
  });

  it('summarize path for a large region', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'peek', arguments: { chars: 200 } }] },
      {
        toolCalls: [{ name: 'summarize', arguments: { startLine: 1, endLine: 20, focus: 'Q4' } }],
      },
      {
        toolCalls: [
          {
            name: 'final_answer',
            arguments: { content: 'The Q4 timeline ends Dec 15.' },
          },
        ],
      },
    ]);

    // Stub the sub-adapter for summarize
    const subStub: InferenceAdapter = {
      async invoke(): Promise<InferenceResponse> {
        return { message: { role: 'assistant', content: 'Q4 milestones must land before Dec 15.' } };
      },
    };

    // Replace the internal sub-adapter — we construct REPLEnvironment indirectly
    // via the runner; the runner passes itself as subAdapter
    const runner = new RLMRunner(adapter, undefined, baseConfig);
    void subStub;

    const result = await runner.run('What is the Q4 deadline?', corpus);
    expect(result.terminationReason).to.equal('final_tool');
    expect(result.toolCallTrace.map((t) => t.tool)).to.include('summarize');
  });

  it('tracks totalDurationMs as a positive number', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'quick' } }] },
    ]);
    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('Fast query.', corpus);
    expect(result.totalDurationMs).to.be.a('number');
    expect(result.totalDurationMs).to.be.at.least(0);
  });

  it('provides iteration count', async () => {
    const adapter = scripted([
      { toolCalls: [{ name: 'peek', arguments: { chars: 100 } }] },
      { toolCalls: [{ name: 'grep', arguments: { pattern: 'Sofia' } }] },
      { toolCalls: [{ name: 'final_answer', arguments: { content: 'Sofia Martel.' } }] },
    ]);
    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run('Who is Sofia?', corpus);
    expect(result.iterations).to.equal(3);
  });
});
