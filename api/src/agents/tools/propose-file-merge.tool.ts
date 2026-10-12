import { tool, type ToolRuntime } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';

const ProposeFileMergeSchema = z.object({
  path: z.string().describe('The workspace-relative path of the file being resolved.'),
  mergedContent: z
    .string()
    .describe(
      'The full, merged file content to propose — the complete file, never a diff or partial snippet.',
    ),
  explanation: z
    .string()
    .describe('A one-line summary of what was kept, dropped, or combined, shown to the user.'),
});

// No store/filesystem dependency, unlike create-workspace.tool.ts/
// create-project.tool.ts — this tool never writes to disk. Its only job is
// to carry a structured proposal through the SSE tool-call event so the
// Files tab can load mergedContent into the conflicted tab as a reviewable
// draft; path/mergedContent/explanation are read directly off the raw
// tool-call arguments by the UI (per docs/superpowers/specs/2026-10-12-
// workspace-file-explorer-sync-and-delete-design.md §2), not from this
// function's return value.
export const proposeFileMergeTool = tool(
  async ({ path, explanation }, runtime: ToolRuntime) => {
    return new Command({
      update: {
        activeGatedSkill: null,
        messages: [
          new ToolMessage({
            content: `Proposed a merged version of "${path}": ${explanation}`,
            tool_call_id: runtime.toolCallId,
            name: 'propose_file_merge',
          }),
        ],
      },
    });
  },
  {
    name: 'propose_file_merge',
    description:
      'Propose a merged version of a file whose local draft conflicts with its on-disk content. ' +
      'Only available once the /resolve-file-conflict skill has been invoked. Writes nothing to ' +
      "disk — the UI reads this call's arguments directly and lets the user review and save.",
    schema: ProposeFileMergeSchema,
  },
);
