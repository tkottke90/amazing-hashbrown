import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { buildSpanTree } from '../../src/tree.js';
import type { SpanRecord } from '../../src/index.js';

function span(
  id: string,
  parent: string | null,
  type: SpanRecord['type'] = 'llm-call',
): SpanRecord {
  return {
    spanId: id,
    traceId: 'trace-1',
    parentSpanId: parent,
    type,
    name: id,
    startedAt: new Date().toISOString(),
    endedAt: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    outputPreview: null,
    inputPreview: null,
    error: null,
  };
}

describe('buildSpanTree', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(buildSpanTree([]), []);
  });

  it('flat list of root spans — all returned with empty children', () => {
    const spans = [span('a', null), span('b', null), span('c', null)];
    const tree = buildSpanTree(spans);
    assert.equal(tree.length, 3);
    assert.ok(tree.every((n) => n.children.length === 0));
  });

  it('one llm-call parent with two tool-call children', () => {
    const spans = [
      span('llm-1', null, 'llm-call'),
      span('tool-1', 'llm-1', 'tool-call'),
      span('tool-2', 'llm-1', 'tool-call'),
    ];
    const tree = buildSpanTree(spans);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].spanId, 'llm-1');
    assert.equal(tree[0].children.length, 2);
    const childIds = tree[0].children.map((c) => c.spanId).sort();
    assert.deepEqual(childIds, ['tool-1', 'tool-2']);
  });

  it('mixed levels — correct tree structure', () => {
    // llm-1
    //   tool-1
    // llm-2 (sibling root)
    //   tool-2
    const spans = [
      span('llm-1', null, 'llm-call'),
      span('tool-1', 'llm-1', 'tool-call'),
      span('llm-2', null, 'llm-call'),
      span('tool-2', 'llm-2', 'tool-call'),
    ];
    const tree = buildSpanTree(spans);
    assert.equal(tree.length, 2);
    const llm1 = tree.find((n) => n.spanId === 'llm-1')!;
    const llm2 = tree.find((n) => n.spanId === 'llm-2')!;
    assert.equal(llm1.children.length, 1);
    assert.equal(llm1.children[0].spanId, 'tool-1');
    assert.equal(llm2.children.length, 1);
    assert.equal(llm2.children[0].spanId, 'tool-2');
  });

  it('orphaned span (parent not in list) becomes a root', () => {
    const spans = [span('tool-orphan', 'missing-parent', 'tool-call')];
    const tree = buildSpanTree(spans);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].spanId, 'tool-orphan');
    assert.equal(tree[0].children.length, 0);
  });
});
