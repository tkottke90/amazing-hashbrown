import type { SpanRecord, SpanNode } from '@tkottke90/llm-common-types/traces';

export function buildSpanTree(spans: SpanRecord[]): SpanNode[] {
  const nodeMap = new Map<string, SpanNode>();
  const roots: SpanNode[] = [];

  for (const span of spans) {
    nodeMap.set(span.spanId, { ...span, children: [] });
  }

  for (const node of nodeMap.values()) {
    if (node.parentSpanId && nodeMap.has(node.parentSpanId)) {
      nodeMap.get(node.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
