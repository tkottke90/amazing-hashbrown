import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { listAllMcpToolRows } from '../tool-config.js';

const UseMcpToolsInputSchema = z.object({
  toolIds: z
    .array(z.string())
    .describe('The MCP tool ids to gain access to, from a prior search_mcp_tools result.'),
});

export type UseMcpToolsRejectionReason = 'not_found' | 'disabled';

export interface UseMcpToolsResult {
  accepted: string[];
  rejected: { toolId: string; reason: UseMcpToolsRejectionReason }[];
}

// Grants access to specific MCP tools for the rest of the current Turn
// (GLOSSARY.md § MCP Tool Discovery) — the grant itself is read back out of
// this tool's own ToolMessage result by
// mcp-tool-discovery.ts's computeDiscoveredToolIds(), not by any shared
// mutable state this tool writes to directly. See ADR-0067.
export function makeUseMcpToolsTool(
  getRows: () => { toolId: string; enabled: boolean }[] = listAllMcpToolRows,
) {
  return tool(
    async ({ toolIds }): Promise<string> => {
      const rows = new Map(getRows().map((r) => [r.toolId, r]));
      const result: UseMcpToolsResult = { accepted: [], rejected: [] };
      for (const id of toolIds) {
        const row = rows.get(id);
        if (!row) result.rejected.push({ toolId: id, reason: 'not_found' });
        else if (!row.enabled) result.rejected.push({ toolId: id, reason: 'disabled' });
        else result.accepted.push(id);
      }
      return JSON.stringify(result);
    },
    {
      name: 'use_mcp_tools',
      description:
        "Grant access to specific MCP tools by id (from a search_mcp_tools result) for the rest of this turn. Returns which ids were accepted and, for each rejected id, why ('not_found' or 'disabled') — use that to correct a typo or explain to the user why a tool isn't available.",
      schema: UseMcpToolsInputSchema,
    },
  );
}

export const useMcpToolsTool = makeUseMcpToolsTool();
