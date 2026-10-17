import { join } from 'node:path';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { SkillsManager } from '@tkottke90/skills-manager';
import type { EditSkillInput } from '@tkottke90/skills-manager';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import { WORKSPACE_SKILLS_DIR } from '../../services/workspace-skills.js';

const MetadataSchema = z.record(z.string(), z.string());

const EditWorkspaceSkillSchema = z.object({
  name: z.string().describe('The existing workspace skill to edit.'),
  description: z.string().optional(),
  body: z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: MetadataSchema.optional(),
  allowedTools: z.string().optional(),
});

export interface MakeEditWorkspaceSkillToolDeps {
  store?: Pick<WorkspaceStore, 'getWorkspace'>;
}

// Same construction as create-workspace-skill.tool.ts — a fresh, writable
// SkillsManager rooted at this workspace's .agents/skills, booted before use.
export function makeEditWorkspaceSkillTool(deps: MakeEditWorkspaceSkillToolDeps = {}) {
  return tool(
    async ({ name, ...changes }, runtime: ToolRuntime) => {
      const workspaceId = runtime.configurable?.workspaceId as string | undefined;
      if (!workspaceId) {
        return 'This tool only works inside a workspace chat — there is no workspace to edit a skill in.';
      }

      const store = deps.store ?? getWorkspaceStore();
      const workspace = store.getWorkspace(workspaceId);
      if (!workspace?.location) {
        return "Could not resolve the current workspace's directory — cannot edit a workspace skill.";
      }

      const manager = new SkillsManager(join(workspace.location, WORKSPACE_SKILLS_DIR));
      await manager.boot();
      try {
        const skill = await manager.edit(name, changes as EditSkillInput);
        return `Updated skill "${skill.name}" in this workspace's .agents/skills. The change is on disk but not committed; review and commit it through the workspace's normal git flow.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) {
          return `${message} — use get_skill_source to confirm the exact name and scope first.`;
        }
        return message;
      }
    },
    {
      name: 'edit_workspace_skill',
      description:
        "Edit an existing skill in the current workspace's .agents/skills (fields given replace the current " +
        'value; anything omitted is left unchanged). Only available once the /create-skill skill has been ' +
        'invoked, and only after the draft has been confirmed with the user. Writes the file to disk but never ' +
        'commits it.',
      schema: EditWorkspaceSkillSchema,
    },
  );
}
