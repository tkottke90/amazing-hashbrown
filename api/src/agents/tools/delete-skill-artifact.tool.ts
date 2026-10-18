import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { isSafeBasename } from '@tkottke90/skills-manager';
import { resolveSkillScope, type ResolveSkillScopeDeps } from './skill-scope-resolver.js';

const DeleteSkillArtifactSchema = z.object({
  skill: z.string().describe('The skill this artifact belongs to.'),
  type: z.enum(['script', 'reference']),
  name: z.string().describe("The artifact's existing filename."),
});

function dirFor(type: 'script' | 'reference'): 'scripts' | 'references' {
  return type === 'script' ? 'scripts' : 'references';
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';
}

// SkillsManager.deleteFile is non-idempotent — it throws ENOENT if the file
// is already gone — so that's caught here and turned into a clean message
// rather than a raw stack trace reaching the model. Only available while
// the create-skill skill is active. Accepts the same injectable deps as
// resolveSkillScope for testability.
export function makeDeleteSkillArtifactTool(deps: ResolveSkillScopeDeps = {}) {
  return tool(
    async ({ skill, type, name }, runtime: ToolRuntime) => {
      if (!isSafeBasename(name)) {
        return `"${name}" is not a safe file name — use letters, numbers, dots, dashes, or underscores only, with no path separators.`;
      }

      const workspaceId = runtime.configurable?.workspaceId as string | undefined;
      const resolution = await resolveSkillScope(skill, workspaceId, deps);
      if (resolution.kind === 'not-found') {
        return `No skill named "${skill}" found in the app-wide Skill Manager${
          workspaceId ? " or this workspace's .agents/skills" : ''
        }.`;
      }
      if (resolution.kind === 'ambiguous') {
        return `"${skill}" exists both app-wide and in this workspace — ask the user (via ask_user) which one they mean first.`;
      }

      const { manager, scope } = resolution;
      if (scope === 'workspace') await manager.boot();

      const dir = dirFor(type);
      try {
        await manager.deleteFile(skill, dir, name);
        return `Removed ${type} "${name}" from "${skill}".`;
      } catch (err) {
        if (isEnoent(err))
          return `No ${type} named "${name}" exists on "${skill}" — nothing to remove.`;
        return err instanceof Error ? err.message : String(err);
      }
    },
    {
      name: 'delete_skill_artifact',
      description:
        'Remove an existing script or reference file from a skill. Only available once the /create-skill ' +
        'skill has been invoked.',
      schema: DeleteSkillArtifactSchema,
    },
  );
}
