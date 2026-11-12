import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { listDiscoverableMcpTools, type DiscoverableMcpTool } from '../tool-config.js';

const SearchMcpToolsInputSchema = z.object({
  keyword: z
    .string()
    .optional()
    .describe(
      'Optional search term. Matches tool id, name, or description (case-insensitive substring). Omit to list every discoverable MCP tool.',
    ),
});

// Resolves the catalog on every call (not once at build time), same reason
// search-skills.tool.ts's makeSearchSkillsTool does — the live MCP catalog and
// its enabled/disabled state can change between calls. See GLOSSARY.md §
// MCP Tool Discovery, ADR-0067.
export function makeSearchMcpToolsTool(
  getCatalog: () => DiscoverableMcpTool[] = listDiscoverableMcpTools,
) {
  return tool(
    async ({ keyword }) => {
      const needle = keyword?.toLowerCase();
      const results = getCatalog().filter(
        (t) =>
          !needle ||
          t.toolId.toLowerCase().includes(needle) ||
          t.name.toLowerCase().includes(needle) ||
          t.description.toLowerCase().includes(needle),
      );
      if (results.length === 0) {
        return keyword
          ? `No MCP tools found matching "${keyword}".`
          : 'No MCP tools are available.';
      }
      return JSON.stringify(results);
    },
    {
      name: 'search_mcp_tools',
      description:
        'Search available MCP tools by keyword. Returns tool ids, names, and descriptions — not full schemas. Call with no argument to list all. Use use_mcp_tools to actually gain access to a result for this turn.',
      schema: SearchMcpToolsInputSchema,
    },
  );
}

// Global instance for call sites with no per-thread/workspace scoping
// (chat-agent.ts's builders) — the MCP catalog is global, not workspace-
// scoped, unlike search_skills.
export const searchMcpToolsTool = makeSearchMcpToolsTool();
