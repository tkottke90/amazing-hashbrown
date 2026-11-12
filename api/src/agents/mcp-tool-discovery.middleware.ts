import { createMiddleware } from 'langchain';
import type { ClientTool } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { toBoundMatchKeys } from './tool-config.js';
import { computeDiscoveredToolIds } from './mcp-tool-discovery.js';

// Adds back the MCP tools Discovered this Turn (issue #408, GLOSSARY.md §
// MCP Tool Discovery, ADR-0067) — the counterpart to the new category-aware
// defaultInclude.chat fallback in tool-config.ts that keeps a non-customized
// MCP tool out of request.tools by default. Takes the agent's own full MCP
// ClientTool candidate list (the same array loadMcpTools() already produces
// and that stays structurally present in every builder's `tools:` array
// passed to createAgent, purely so ToolNode can execute a call if one ever
// comes through — same shape Skill-Gated Tools already relies on).
//
// MUST be placed immediately after toolAccessMiddleware in every builder's
// middleware array: it needs to receive request.tools *after*
// toolAccessMiddleware has already stripped non-customized MCP tools out
// under the new default, so it can add back only what's actually Discovered
// — adding it anywhere else either does nothing (if tool-access hasn't run
// yet, there's nothing stripped to add back) or risks re-adding a tool
// tool-access would otherwise correctly exclude.
export function createMcpToolDiscoveryMiddleware(mcpTools: ClientTool[]) {
  // Keyed by boundName (mcpTools' own .name) — the same forward-only
  // colon-to-double-underscore conversion toBoundMatchKeys() already uses.
  // Never parse a boundName back into a display id (deliberately unsupported
  // everywhere in this codebase — see toBoundMatchKeys()'s own comment);
  // convert the discovered display id forward instead.
  const byBoundName = new Map(mcpTools.map((t) => [t.name as string, t]));

  return createMiddleware({
    name: 'McpToolDiscoveryMiddleware',
    wrapModelCall: async (request, handler) => {
      const discoveredIds = computeDiscoveredToolIds(request.messages as BaseMessage[]);
      if (discoveredIds.size === 0) return handler(request);

      const boundSet = new Set(request.tools.map((t) => t.name as string));
      const additions = [...toBoundMatchKeys(discoveredIds)]
        .map((boundName) => byBoundName.get(boundName))
        .filter((t): t is ClientTool => t !== undefined && !boundSet.has(t.name as string));

      if (additions.length === 0) return handler(request);
      return handler({ ...request, tools: [...request.tools, ...additions] });
    },
  });
}
