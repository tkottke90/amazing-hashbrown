import type { z } from 'zod';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodType;
}
