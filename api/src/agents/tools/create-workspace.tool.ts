import { tool, type ToolRuntime } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { WikiRegistry } from '@tkottke90/llm-wiki';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import { getWikiRegistry } from '../../services/wiki.js';
import { getActiveSseWriter } from '../active-sse-writer.js';
import { createWorkspaceHandler } from '../../routes/v1/workspaces.handlers.js';
import { slugify } from '../../routes/v1/projects.handlers.js';

const CreateWorkspaceSchema = z.object({
  name: z.string().describe('The workspace name.'),
  goal: z.string().optional().describe('What this workspace is for, in a sentence or two.'),
  wikiId: z
    .string()
    .optional()
    .describe(
      'Name/id/tag of an existing wiki domain to bind this workspace to. Must match a domain returned by the wiki domain list — validated before creation.',
    ),
  git: z
    .boolean()
    .optional()
    .describe('Whether to initialize git in the workspace directory. Defaults to false.'),
});

function matchesWikiQuery(
  domain: { id: string; domain: string; tags: string[] },
  query: string,
): boolean {
  const q = query.toLowerCase();
  return (
    domain.id.toLowerCase() === q ||
    domain.domain.toLowerCase() === q ||
    domain.tags.some((tag) => tag.toLowerCase() === q)
  );
}

// Factory-injected store/registry (defaulting to the production singletons)
// so this tool is directly testable against a real, temp-dir-backed
// WorkspaceStore/WikiRegistry — matches makeWikiAddCrossLinkTool's pattern
// rather than wiki-create-domain.tool.ts's untestable singleton-only style.
export function makeCreateWorkspaceTool(store?: WorkspaceStore, registry?: WikiRegistry) {
  return tool(
    async ({ name, goal, wikiId, git }, runtime: ToolRuntime) => {
      const s = store ?? getWorkspaceStore();

      let resolvedWikiId = wikiId;
      if (wikiId) {
        const reg = registry ?? (await getWikiRegistry());
        const domains = reg.list();
        const match = domains.find((d) => matchesWikiQuery(d, wikiId));
        if (!match) {
          const available = domains.map((d) => d.id).join(', ') || '(none registered yet)';
          return `No wiki domain matches "${wikiId}". Available domains: ${available}. Ask the user which one they meant, or omit wiki binding.`;
        }
        resolvedWikiId = match.id;
      }

      const directoryName = slugify(name);
      const result = await createWorkspaceHandler(s, {
        name,
        goal,
        wikiId: resolvedWikiId,
        git: git ?? false,
        directoryName,
        locationRoot: 'projects',
      });

      if (!result.ok) {
        if (result.status === 409 || result.status === 400) return result.error;
        return `Workspace creation failed: ${result.error}. Try again from the Workspaces page (/workspaces) if this keeps happening.`;
      }

      const workspace = result.data;
      if (!workspace) {
        return 'Workspace creation failed unexpectedly. Try again from the Workspaces page (/workspaces).';
      }
      const threadId = (runtime.configurable?.thread_id as string | undefined) ?? '';
      getActiveSseWriter(threadId)?.({
        type: 'resource_created',
        resourceType: 'workspace',
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
              content: `Created workspace "${workspace.name}" at ${workspace.location}.`,
              tool_call_id: runtime.toolCallId,
              name: 'create_workspace',
            }),
          ],
        },
      });
    },
    {
      name: 'create_workspace',
      description:
        'Create a new workspace after all required fields have been collected and confirmed with the user. ' +
        'Only available once the /create-workspace skill has been invoked.',
      schema: CreateWorkspaceSchema,
    },
  );
}
