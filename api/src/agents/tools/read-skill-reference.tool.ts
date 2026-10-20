import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { isSafeBasename } from '@tkottke90/skills-manager';
import { resolveSkillScope, type ResolveSkillScopeDeps } from './skill-scope-resolver.js';

// .passthrough(), not the zod default of stripping unknown keys: the
// Active Skill the middleware injects (see skill-scoped-tools.middleware.ts)
// arrives as an extra key on this same object, never declared here so the
// model-visible schema never advertises it.
const ReadSkillReferenceSchema = z
  .object({
    name: z.string().describe('The reference filename to read (e.g. "operations.md").'),
  })
  .passthrough();

// A Skill-Scoped Tool (see GLOSSARY.md § Skill Invocation & Runtime Access):
// deliberately takes no skill argument — "which skill" resolves only from
// the Active Skill, injected into this call's own args by
// skill-scoped-tools.middleware.ts's wrapToolCall hook, never from anything
// the model supplies. That's what makes cross-skill file access impossible
// by construction rather than by convention (issue #319's acceptance
// criteria). Accepts the same injectable deps as resolveSkillScope
// (defaulting to the production singletons) so this is directly testable
// against temp-dir-backed managers, matching get-skill-source.tool.ts.
export function makeReadSkillReferenceTool(deps: ResolveSkillScopeDeps = {}) {
  return tool(
    async ({ name, activeSkill }, runtime: ToolRuntime) => {
      const skill = activeSkill as string | null | undefined;
      if (!skill) {
        return 'No skill is currently active — this tool is only available while a skill is active.';
      }
      if (!isSafeBasename(name)) {
        return `"${name}" is not a safe file name — use letters, numbers, dots, dashes, or underscores only, with no path separators.`;
      }

      const workspaceId = runtime.configurable?.workspaceId as string | undefined;
      const resolution = await resolveSkillScope(skill, workspaceId, deps);
      if (resolution.kind === 'not-found') {
        return `The active skill "${skill}" could not be resolved.`;
      }
      if (resolution.kind === 'ambiguous') {
        return `"${skill}" exists both app-wide and in this workspace — ask the user (via ask_user) which one they mean first.`;
      }

      const { manager, scope } = resolution;
      if (scope === 'workspace') await manager.boot();

      try {
        return await manager.readFile(skill, 'references', name);
      } catch {
        return `No reference file named "${name}" for the active skill.`;
      }
    },
    {
      name: 'read_skill_reference',
      description:
        "Read a reference file belonging to whichever skill is currently active. Scoped to that skill's " +
        "own references/ only — there is no way to read another skill's files with this tool.",
      schema: ReadSkillReferenceSchema,
    },
  );
}
