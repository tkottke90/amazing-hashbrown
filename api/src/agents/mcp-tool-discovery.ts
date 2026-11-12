// MCP Tool Discovery (issue #408) — pure logic shared by the production
// middleware chain (mcp-tool-discovery.middleware.ts's wrapModelCall reads
// request.messages) and any future non-middleware caller, same split
// tool-syntax.ts/tool-syntax.middleware.ts already established for a similar
// reason. See GLOSSARY.md § MCP Tool Discovery, ADR-0067.

import { isToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

interface UseMcpToolsResult {
  accepted: string[];
}

function safeParseUseMcpToolsResult(content: unknown): UseMcpToolsResult | null {
  try {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.accepted) ? (parsed as UseMcpToolsResult) : null;
  } catch {
    return null;
  }
}

// Walks `messages` backward until the Turn boundary (the last human message —
// the same boundary GLOSSARY.md's Turn is already defined against), collecting
// the `accepted` list from every use_mcp_tools ToolMessage result seen along
// the way. Multiple use_mcp_tools calls within one Turn union together — a
// later, narrower call doesn't un-grant an earlier one. A `use_mcp_tools` call
// from a previous Turn never contributes, since the scan stops at the human
// message boundary before reaching it.
export function computeDiscoveredToolIds(messages: BaseMessage[]): Set<string> {
  const ids = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.getType() === 'human') break;
    if (isToolMessage(msg) && msg.name === 'use_mcp_tools') {
      const parsed = safeParseUseMcpToolsResult(msg.content);
      for (const id of parsed?.accepted ?? []) ids.add(id);
    }
  }
  return ids;
}
