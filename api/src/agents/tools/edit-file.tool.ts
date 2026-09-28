import { readFile, writeFile } from 'node:fs/promises';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveFilePathUnderWorkspace } from '../../services/workspace-location.js';

const EditFileSchema = z.object({
  path: z.string().min(1).describe('Path to the file, relative to the workspace root.'),
  old_string: z
    .string()
    .min(1)
    .describe('Exact text to find and replace. Must match exactly once in the file.'),
  new_string: z.string().describe('Replacement text.'),
});

// Exact-string SEARCH/REPLACE, not a patch/diff format — real Unix `patch`
// requires exact context-line matching, which is a well-documented weak
// point for local models. Rejecting on zero or multiple matches (rather than
// replacing the first occurrence) means a wrong edit never gets applied
// silently; the model gets a chance to make old_string more specific instead.
export function makeEditFileTool(workspaceLocation: string) {
  return tool(
    async ({
      path: relPath,
      old_string: oldString,
      new_string: newString,
    }: {
      path: string;
      old_string: string;
      new_string: string;
    }) => {
      let resolved: string;
      try {
        resolved = resolveFilePathUnderWorkspace(workspaceLocation, relPath);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }

      let content: string;
      try {
        content = await readFile(resolved, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Could not read "${relPath}": ${message}`;
      }

      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        return `"old_string" was not found in "${relPath}". No changes made.`;
      }
      if (occurrences > 1) {
        return (
          `"old_string" matches ${occurrences} locations in "${relPath}" — it must match ` +
          `exactly once. Add more surrounding context to make it unique. No changes made.`
        );
      }

      const updated = content.replace(oldString, newString);
      await writeFile(resolved, updated, 'utf8');
      return `Replaced 1 occurrence in "${relPath}".`;
    },
    {
      name: 'edit_file',
      description:
        'Replace an exact block of text in a workspace file (old_string -> new_string). ' +
        'old_string must match exactly once in the file. Only available while the "file-ops" ' +
        'skill is active.',
      schema: EditFileSchema,
    },
  );
}
