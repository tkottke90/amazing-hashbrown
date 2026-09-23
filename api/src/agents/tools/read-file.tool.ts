import { readFile } from 'node:fs/promises';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveFilePathUnderWorkspace } from '../../services/workspace-location.js';

const ReadFileSchema = z.object({
  path: z.string().min(1).describe('Path to the file, relative to the workspace root.'),
});

export function makeReadFileTool(workspaceLocation: string) {
  return tool(
    async ({ path: relPath }: { path: string }) => {
      let resolved: string;
      try {
        resolved = resolveFilePathUnderWorkspace(workspaceLocation, relPath);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }

      try {
        return await readFile(resolved, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Could not read "${relPath}": ${message}`;
      }
    },
    {
      name: 'read_file',
      description:
        "Read a file's full contents from the current workspace by path. " +
        'Only available while the "file-ops" skill is active.',
      schema: ReadFileSchema,
    },
  );
}
