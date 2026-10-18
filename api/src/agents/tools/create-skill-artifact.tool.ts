import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { isSafeBasename } from '@tkottke90/skills-manager';
import { resolveSkillScope, type ResolveSkillScopeDeps } from './skill-scope-resolver.js';

const CreateSkillArtifactSchema = z.object({
  skill: z.string().describe('The skill this artifact belongs to.'),
  type: z.enum(['script', 'reference']),
  name: z.string().describe('The artifact\'s filename (e.g. "run.py", "style-guide.md").'),
  content: z.string(),
});

function dirFor(type: 'script' | 'reference'): 'scripts' | 'references' {
  return type === 'script' ? 'scripts' : 'references';
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';
}

// Refuses to overwrite an existing artifact — use update_skill_artifact for
// that — since SkillsManager.writeFile itself has no such check (plain
// overwrite). Only available while the create-skill skill is active.
// Accepts the same injectable deps as resolveSkillScope for testability.
export function makeCreateSkillArtifactTool(deps: ResolveSkillScopeDeps = {}) {
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
      try {
        await manager.readFile(skill, dir, name);
        return `"${name}" already exists under ${skill}/${dir} — use update_skill_artifact to change it.`;
      } catch (err) {
        if (!isEnoent(err)) {
          return err instanceof Error ? err.message : String(err);
        }
      }

      await manager.writeFile(skill, dir, name, content);
      return `Added ${type} "${name}" to "${skill}".`;
    },
    {
      name: 'create_skill_artifact',
      description:
        'Add a new script or reference file to a skill. Fails if the file already exists — use ' +
        'update_skill_artifact to change an existing one. Only available once the /create-skill skill has ' +
        'been invoked.',
      schema: CreateSkillArtifactSchema,
    },
  );
}
