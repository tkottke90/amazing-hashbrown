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
