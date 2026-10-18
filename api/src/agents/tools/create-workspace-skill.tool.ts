import { join } from 'node:path';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { SkillsManager } from '@tkottke90/skills-manager';
import type { CreateSkillInput } from '@tkottke90/skills-manager';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import { WORKSPACE_SKILLS_DIR } from '../../services/workspace-skills.js';

const MetadataSchema = z.record(z.string(), z.string());

const CreateWorkspaceSkillSchema = z.object({
  name: z
    .string()
    .describe(
      'Lowercase, hyphenated skill name (e.g. "wiki-search-tips") — also becomes the slash command.',
    ),
  description: z
    .string()
    .describe(
      'What this skill does and when it should trigger. This is the literal text search_skills ' +
        'and the slash menu match against, so it needs concrete trigger phrases, not a vague summary.',
    ),
  body: z.string().describe('The skill instructions, as Markdown.'),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: MetadataSchema.optional(),
  allowedTools: z.string().optional(),
});

function mapCreateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('already exists')) {
    return `${message} — use edit_workspace_skill instead, or pick a different name.`;
  }
  return message;
}

export interface MakeCreateWorkspaceSkillToolDeps {
  store?: Pick<WorkspaceStore, 'getWorkspace'>;
}

// Deliberately NOT built on resolveWorkspaceSkills()'s read-only child
// manager (services/workspace-skills.ts) — that manager's assertWritable()
// throws unconditionally. This constructs a separate, writable SkillsManager
// rooted at the same .agents/skills directory and boots it (required here,
// unlike a read-only lookup — create() needs the cache populated to detect
// a duplicate name). Only available while the create-skill skill is active.
export function makeCreateWorkspaceSkillTool(deps: MakeCreateWorkspaceSkillToolDeps = {}) {
  return tool(
    async (input, runtime: ToolRuntime) => {
      const workspaceId = runtime.configurable?.workspaceId as string | undefined;
      if (!workspaceId) {
        return 'This tool only works inside a workspace chat — there is no workspace to put a skill in. Use create_app_skill instead, or ask which workspace to target.';
      }

      const store = deps.store ?? getWorkspaceStore();
      const workspace = store.getWorkspace(workspaceId);
      if (!workspace?.location) {
        return "Could not resolve the current workspace's directory — cannot create a workspace skill.";
      }

      const manager = new SkillsManager(join(workspace.location, WORKSPACE_SKILLS_DIR));
      await manager.boot();
      try {
        const skill = await manager.create(input as CreateSkillInput);
        return `Created skill "${skill.name}" in this workspace's .agents/skills — available here as ${skill.slashCommand}. The file is on disk but not committed; review and commit it through the workspace's normal git flow.`;
      } catch (err) {
        return mapCreateError(err);
      }
    },
    {
      name: 'create_workspace_skill',
      description:
        "Create a new skill scoped to the current workspace's .agents/skills (not visible outside it). " +
        'Only available once the /create-skill skill has been invoked, and only after the draft has been ' +
        'confirmed with the user. Writes the file to disk but never commits it.',
      schema: CreateWorkspaceSkillSchema,
    },
  );
}
