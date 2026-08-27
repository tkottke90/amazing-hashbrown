import { tool, type ToolRuntime } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { WikiRegistry } from '@tkottke90/llm-wiki';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import { getActiveSseWriter } from '../active-sse-writer.js';
import { createProjectHandler, slugify } from '../../routes/v1/projects.handlers.js';

const CreateProjectSchema = z.object({
  name: z.string().describe('The project name.'),
  goal: z.string().optional().describe('What this project is for, in a sentence or two.'),
  winCondition: z.string().describe('What "done" looks like for this project.'),
  dueAt: z.string().optional().describe('ISO 8601 due date/time, if the user gave one.'),
  git: z
    .boolean()
    .optional()
    .describe('Whether to initialize git in the project directory. Defaults to false.'),
});

// Factory-injected store/registry (defaulting to the production singletons)
// so this tool is directly testable against a real, temp-dir-backed
// WorkspaceStore/WikiRegistry — matches makeWikiAddCrossLinkTool's pattern
// rather than wiki-create-domain.tool.ts's untestable singleton-only style.
// No wikiId param: createProjectHandler always provisions a fresh ephemeral
// wiki and rejects a caller-supplied one, so /create-project never asks.
export function makeCreateProjectTool(store?: WorkspaceStore, registry?: WikiRegistry) {
  return tool(
    async ({ name, goal, winCondition, dueAt, git }, runtime: ToolRuntime) => {
      const s = store ?? getWorkspaceStore();

      const directoryName = slugify(name);
      const result = await createProjectHandler(
        s,
        {
          name,
          goal,
          winCondition,
          dueAt,
          git: git ?? false,
          directoryName,
          locationRoot: 'projects',
        },
        registry,
      );

      if (!result.ok) {
        if (result.status === 409 || result.status === 400) return result.error;
        return `Project creation failed: ${result.error}. Try again from the Workspaces page (/workspaces) if this keeps happening.`;
      }

      const { workspace } = result.data;
      const threadId = (runtime.configurable?.thread_id as string | undefined) ?? '';
      getActiveSseWriter(threadId)?.({
        type: 'resource_created',
        resourceType: 'project',
        name: workspace.name,
        goal: workspace.goal ?? undefined,
        location: workspace.location,
        workspaceId: workspace.id,
      });

      return new Command({
        update: {
          activeGatedSkill: null,
          messages: [
            new ToolMessage({
              content: `Created project "${workspace.name}" at ${workspace.location}.`,
              tool_call_id: runtime.toolCallId,
              name: 'create_project',
            }),
          ],
        },
      });
    },
    {
      name: 'create_project',
      description:
        'Create a new project (a workspace plus win condition, with a fresh ephemeral wiki) after all required ' +
        'fields have been collected and confirmed with the user. Only available once the /create-project skill has been invoked.',
      schema: CreateProjectSchema,
    },
  );
}
