import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveFilePathUnderWorkspace } from '../../services/workspace-location.js';
import { globToRegExp } from './glob-match.js';

const FindFileSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Glob-like pattern to match file names against, e.g. "*.ts" or "**/*.test.ts".'),
  path: z
    .string()
    .optional()
    .describe('Subdirectory within the workspace to search under. Defaults to the workspace root.'),
});

const MAX_RESULTS = 200;

// matchRoot is the directory the pattern is matched relative to (the search
// scope — the "path" argument if given, else the workspace root);
// displayRoot is always the workspace root, so returned paths are always
// usable directly as a read_file/edit_file "path" argument regardless of
// how the search was scoped.
async function walk(
  dir: string,
  matchRoot: string,
  displayRoot: string,
  regex: RegExp,
  results: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, matchRoot, displayRoot, regex, results);
    } else if (entry.isFile()) {
      // A bare "*.ts" should only match a file directly under the search
      // scope, the same as standard glob semantics — matched against the
      // path relative to matchRoot, not the bare basename (which would
      // silently ignore both nesting and the "path" scoping argument).
      const relForMatch = path.relative(matchRoot, full);
      if (regex.test(relForMatch)) {
        results.push(path.relative(displayRoot, full));
      }
    }
  }
}

// Bound to a workspace root the same way makeShellExecTool(workingDirectory)
// is — reuses resolveFilePathUnderWorkspace for the same path-containment
// guarantee every other workspace-scoped file operation gets, rather than
// reimplementing traversal checks here.
export function makeFindFileTool(workspaceLocation: string) {
  return tool(
    async ({ pattern, path: subPath }: { pattern: string; path?: string }) => {
      let searchRoot: string;
      try {
        searchRoot = subPath
          ? resolveFilePathUnderWorkspace(workspaceLocation, subPath)
          : path.resolve(workspaceLocation);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }

      const regex = globToRegExp(pattern);
      const results: string[] = [];
      await walk(searchRoot, searchRoot, path.resolve(workspaceLocation), regex, results);

      if (results.length === 0) {
        return `No files matched "${pattern}"${subPath ? ` under "${subPath}"` : ''}.`;
      }
      const truncated = results.length >= MAX_RESULTS;
      return (
        results.join('\n') +
        (truncated
          ? `\n… showing the first ${MAX_RESULTS} matches, narrow the pattern for more.`
          : '')
      );
    },
    {
      name: 'find_file',
      description:
        'Find files in the current workspace by name/glob pattern. Returns matching paths ' +
        'relative to the workspace root, one per line. Only available while the "file-ops" ' +
        'skill is active.',
      schema: FindFileSchema,
    },
  );
}
