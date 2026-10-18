import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveSkillScope, type ResolveSkillScopeDeps } from './skill-scope-resolver.js';

const GetSkillSourceSchema = z.object({
  name: z.string().describe('The skill to inspect, for repair or review.'),
});

// Built on SkillsManager.inspect(), not load() — inspect() reads a skill's
// SKILL.md directly off disk, independent of boot()'s cache, so this works
// even for a skill broken enough to have failed boot() validation (and
// therefore never entered the cache load()/lookup() rely on). That's the
// exact case repair exists for: without this, the most broken skills would
// be the ones this tool could never reach. Only available while the
// create-skill skill is active. Accepts the same injectable deps as
// resolveSkillScope (defaulting to the production singletons) so this is
// directly testable against temp-dir-backed managers.
export function makeGetSkillSourceTool(deps: ResolveSkillScopeDeps = {}) {
  return tool(
    async ({ name }, runtime: ToolRuntime) => {
      const workspaceId = runtime.configurable?.workspaceId as string | undefined;
      const resolution = await resolveSkillScope(name, workspaceId, deps);

      if (resolution.kind === 'not-found') {
        return `No skill named "${name}" found in the app-wide Skill Manager${
          workspaceId ? " or this workspace's .agents/skills" : ''
        }.`;
      }
      if (resolution.kind === 'ambiguous') {
        return (
          `"${name}" exists both app-wide and in this workspace's .agents/skills — ` +
          'ask the user (via ask_user) which one they mean before doing anything else with it.'
        );
      }

      const inspection = await resolution.manager.inspect(name);
      return JSON.stringify({
        scope: resolution.scope,
        exists: inspection.exists,
        frontmatter: inspection.frontmatter,
        body: inspection.body,
        scripts: Object.keys(inspection.scripts ?? {}),
        references: Object.keys(inspection.references ?? {}),
        nameMismatch: inspection.nameMismatch,
        issue: inspection.issue,
      });
    },
    {
      name: 'get_skill_source',
      description:
        "Read a skill's current frontmatter, body, and artifact list, plus any compliance issue found " +
        'against the real validation rules — use this before repairing a skill, so questions are framed ' +
        'around its actual, concrete problem rather than a guess. Only available once the /create-skill ' +
        'skill has been invoked.',
      schema: GetSkillSourceSchema,
    },
  );
}
