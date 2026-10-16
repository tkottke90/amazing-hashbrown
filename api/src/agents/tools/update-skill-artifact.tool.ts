import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { isSafeBasename } from '@tkottke90/skills-manager';
import { resolveSkillScope, type ResolveSkillScopeDeps } from './skill-scope-resolver.js';

const UpdateSkillArtifactSchema = z.object({
  skill: z.string().describe('The skill this artifact belongs to.'),
  type: z.enum(['script', 'reference']),
  name: z.string().describe("The artifact's existing filename."),
  content: z.string(),
});

function dirFor(type: 'script' | 'reference'): 'scripts' | 'references' {
  return type === 'script' ? 'scripts' : 'references';
}

// Plain overwrite — unlike create_skill_artifact, no existence check first.
// Only available while the create-skill skill is active. Accepts the same
// injectable deps as resolveSkillScope for testability.
export function makeUpdateSkillArtifactTool(deps: ResolveSkillScopeDeps = {}) {
  return tool(
    async ({ skill, type, name, content }, runtime: ToolRuntime) => {
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
      await manager.writeFile(skill, dir, name, content);
      return `Updated ${type} "${name}" on "${skill}".`;
    },
    {
      name: 'update_skill_artifact',
      description:
        "Overwrite an existing skill's script or reference file with new content. Use " +
        'create_skill_artifact instead for a file that does not exist yet. Only available once the ' +
        '/create-skill skill has been invoked.',
      schema: UpdateSkillArtifactSchema,
    },
  );
}
