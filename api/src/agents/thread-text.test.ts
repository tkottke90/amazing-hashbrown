import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { ThreadMessageRecord } from '../services/thread-store.js';
import { extractText, transcriptLine } from './thread-text.js';

function msg(kind: string, payload: unknown): ThreadMessageRecord {
  return {
    id: 'm',
    threadId: 't',
    seq: 1,
    kind,
    status: null,
    retryOf: null,
    checkpointId: null,
    payload,
    provider: null,
    model: null,
    createdAt: '',
    updatedAt: '',
  };
}

describe('agents/thread-text', () => {
  it('extracts trimmed user and assistant text [unit]', () => {
    expect(extractText(msg('user', { content: '  hi  ' }))).to.equal('hi');
    expect(extractText(msg('assistant', { content: 'done' }))).to.equal('done');
  });

  it('renders a tool call as its name and result, falling back to the error [unit]', () => {
    expect(extractText(msg('tool_call', { name: 'shell_exec', result: 'ok' }))).to.equal(
      'Tool: shell_exec\nResult: ok',
    );
    expect(extractText(msg('tool_call', { name: 'web_fetch', error: { code: 404 } }))).to.equal(
      'Tool: web_fetch\nResult: {"code":404}',
    );
  });

  it('skips UI-only kinds and empty content, which carry nothing worth reading back [unit]', () => {
    expect(extractText(msg('task_run_marker', { taskId: 'x' }))).to.equal(null);
    expect(extractText(msg('assistant', { content: '   ' }))).to.equal(null);
    expect(transcriptLine(msg('hitl_prompt', { question: 'q' }))).to.equal(null);
  });

  it('labels each transcript line by who produced it [unit]', () => {
    expect(transcriptLine(msg('user', { content: 'a' }))).to.equal('[User] a');
    expect(transcriptLine(msg('assistant', { content: 'b' }))).to.equal('[Agent] b');
    expect(transcriptLine(msg('tool_call', { name: 'x', result: 'y' }))).to.equal(
      '[Tool call] Tool: x\nResult: y',
    );
  });

  it('clips one oversized entry so a single tool dump cannot eat a whole transcript page [unit]', () => {
    const line = transcriptLine(msg('assistant', { content: 'x'.repeat(5000) }))!;
    expect(line.length).to.be.lessThan(2100);
    expect(line.endsWith('…')).to.equal(true);
  });
});
