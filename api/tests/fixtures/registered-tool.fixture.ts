import { z } from 'zod';
import type { RegisteredTool } from '@tkottke90/tools-manager';

/**
 * Factory for a minimal MCP-sourced RegisteredTool.
 * Override any field to set up the specific scenario under test.
 */
export function makeMcpTool(
  overrides: Partial<RegisteredTool> & {
    execute?: (args: Record<string, unknown>) => Promise<unknown>;
  } = {},
): RegisteredTool {
  return {
    name: 'test_tool',
    description: 'A test MCP tool',
    // Double-cast required: same Zod version mismatch as in production code
    parameters: z.object({}) as unknown as RegisteredTool['parameters'],
    source: 'mcp',
    execute: async () => 'default result',
    ...overrides,
  };
}
