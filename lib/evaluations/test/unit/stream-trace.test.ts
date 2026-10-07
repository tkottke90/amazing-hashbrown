import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  formatStreamTrace,
  longestRepeatRun,
  summarizeStreamTrace,
  toTraceChunks,
  type TraceChunk,
} from '../../src/stream-trace.js';

const content = (text: string): TraceChunk => ({ channel: 'content', text });
const reasoning = (text: string): TraceChunk => ({ channel: 'reasoning', text });

describe('toTraceChunks', () => {
  it('splits one streamed chunk into its reasoning, content and tool_call parts [unit]', () => {
    const chunks = toTraceChunks({
      content: 'hi',
      additional_kwargs: { reasoning_content: 'thinking' },
      tool_call_chunks: [{ name: 'wiki_search', args: '{"q":1}' }],
    });
    assert.deepEqual(chunks, [
      { channel: 'reasoning', text: 'thinking' },
      { channel: 'content', text: 'hi' },
      { channel: 'tool_call', text: 'wiki_search{"q":1}' },
    ]);
  });

  it('omits channels that are empty so keep-alive chunks add nothing [unit]', () => {
    assert.deepEqual(
      toTraceChunks({ content: '', additional_kwargs: { reasoning_content: '' } }),
      [],
    );
  });

  it('reads text out of content-block arrays [unit]', () => {
    const chunks = toTraceChunks({
      content: [{ type: 'text', text: 'a' }, { type: 'image' }, { text: 'b' }],
    });
    assert.deepEqual(chunks, [{ channel: 'content', text: 'ab' }]);
  });
});

describe('longestRepeatRun', () => {
  it('returns null for an empty trace [unit]', () => {
    assert.equal(longestRepeatRun([]), null);
  });

  it('finds a run of identical chunks and where it starts [unit]', () => {
    const run = longestRepeatRun([
      content('a'),
      content('b'),
      content('b'),
      content('b'),
      content('c'),
    ]);
    assert.equal(run?.trimmedText, 'b');
    assert.equal(run?.length, 3);
    assert.equal(run?.startIndex, 1);
  });

  it('treats chunks differing only in surrounding whitespace as the same token [unit]', () => {
    const run = longestRepeatRun([content(' x'), content('x\n'), content('x')]);
    assert.equal(run?.length, 3);
  });

  it('counts whitespace-only chunks as a repeated empty token and keeps the raw sample [unit]', () => {
    const run = longestRepeatRun([
      content('{'),
      content('\n'),
      content(' '),
      content('\n\n'),
      content('}'),
    ]);
    assert.equal(run?.trimmedText, '');
    assert.equal(run?.length, 3);
    assert.equal(run?.sampleText, '\n');
  });

  it('does not let a reasoning chunk break a content run [unit]', () => {
    const run = longestRepeatRun([content('x'), reasoning('think'), content('x'), content('x')]);
    assert.equal(run?.channel, 'content');
    assert.equal(run?.length, 3);
  });

  it('does not merge identical text across different channels [unit]', () => {
    const run = longestRepeatRun([content('x'), reasoning('x')]);
    assert.equal(run?.length, 1);
  });

  it('reports the longest run when several exist [unit]', () => {
    const run = longestRepeatRun([
      content('a'),
      content('a'),
      content('b'),
      content('b'),
      content('b'),
    ]);
    assert.equal(run?.trimmedText, 'b');
    assert.equal(run?.length, 3);
  });
});

describe('summarizeStreamTrace', () => {
  it('counts chunks and characters per channel [unit]', () => {
    const summary = summarizeStreamTrace([content('abc'), reasoning('de'), content('f')]);
    assert.equal(summary.totalChunks, 3);
    assert.deepEqual(summary.perChannel.content, { chunks: 2, chars: 4 });
    assert.deepEqual(summary.perChannel.reasoning, { chunks: 1, chars: 2 });
    assert.deepEqual(summary.perChannel.tool_call, { chunks: 0, chars: 0 });
  });
});

describe('formatStreamTrace', () => {
  it('collapses a long repeat into one row and shows the text before it [unit]', () => {
    const chunks = [
      content('{"query":"'),
      ...Array.from({ length: 150 }, () => content(' ')),
      content('"}'),
    ];
    const text = formatStreamTrace(chunks);
    assert.match(text, /Longest repeat: 150 consecutive "content" chunks of \(whitespace only\)/);
    assert.match(text, /#1\.\.#150 ×150 \[content\] " "/);
    assert.ok(
      text.includes(JSON.stringify('{"query":"')),
      'lead-in text before the repeat is shown',
    );
    assert.ok(text.split('\n').length < 20, 'repeat must not flood the output');
  });

  it('shows visible JSON-escaped text for a non-whitespace repeat [unit]', () => {
    const text = formatStreamTrace(Array.from({ length: 4 }, () => content('wiki_search?')));
    assert.match(text, /4 consecutive "content" chunks of "wiki_search\?"/);
  });

  it('limits the tail to the requested number of groups [unit]', () => {
    const chunks = ['a', 'b', 'c', 'd', 'e'].map(content);
    const text = formatStreamTrace(chunks, { tailLines: 2 });
    assert.match(text, /Last 2 chunk groups \(of 5\)/);
    assert.ok(!text.includes('#0 [content]'), 'oldest groups are dropped from the tail');
    assert.ok(text.includes('#4 [content] "e"'), 'the newest group is kept');
  });

  it('handles an empty trace without throwing [unit]', () => {
    assert.match(formatStreamTrace([]), /Streamed 0 chunks/);
  });
});
