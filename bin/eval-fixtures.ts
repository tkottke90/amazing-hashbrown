import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// Eval-only fixture standing in for any future image-producing tool (e.g. a
// ComfyUI MCP integration, a chart renderer) that hasn't been built yet.
// Never bound to the production chat agent (api/src/agents/chat-agent.ts),
// never actually invoked by the eval runner — tool-sequence scenarios only
// ever seed a fake prior *result* for this tool, they never call its
// handler. The throw below is a defensive guard, not expected to fire.
export const fakeGenerateImageTool = tool(
  async (): Promise<never> => {
    throw new Error('fakeGenerateImageTool: eval fixture, never meant to execute');
  },
  {
    name: 'generate_image',
    description: 'Generates an image from a text prompt and returns base64 image bytes.',
    schema: z.object({ prompt: z.string() }),
  },
);

// Eval-only fixture standing in for a real, cacheable MCP tool
// (api/src/agents/chat-agent.ts's mcpToolToLangChain/extendWithForceRefresh),
// bound under the exact boundName suites/mcp-tool-cache.yaml's seeded turns
// use. Real MCP tools are never part of evalTools (see its comment) because
// they're dynamic/live-server-dependent — but that suite's own purpose is to
// test the model's judgment around forceRefresh on a cacheable MCP tool, so
// it needs *some* tool bound under this name/shape to assert against, same
// reasoning as fakeGenerateImageTool above. The schema mirrors
// extendWithForceRefresh()'s actual extension (forceRefresh as an optional
// boolean) so argChecks on that field resolve the same way they would
// against a real cached MCP tool. Never invoked by the runner — tool-call/
// tool-sequence scenarios only inspect response.tool_calls.
export const fakeN8nGetWorkflowDetailsTool = tool(
  async (): Promise<never> => {
    throw new Error('fakeN8nGetWorkflowDetailsTool: eval fixture, never meant to execute');
  },
  {
    name: 'n8n__get_workflow_details',
    description: 'Fetches an n8n workflow definition by id.',
    schema: z.object({
      workflowId: z.string(),
      detailLevel: z.string().optional(),
      forceRefresh: z.boolean().optional(),
    }),
  },
);
