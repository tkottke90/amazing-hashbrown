import { createMiddleware } from 'langchain';
import { z } from 'zod';
import type { SkillsManager } from '@tkottke90/skills-manager';
import { skillsManager as defaultSkillsManager } from '../services/skills-manager.js';
import { resolveSkillGatedRegistrations } from './skill-tool-gating.js';

// Reusable "Skill-Gated Tools" pattern — see AGENTS.md § Composition over
// Customization and README.md § Design philosophy: context is scarce. A
// tool that's only useful once a specific slash-command skill has been
// invoked shouldn't sit in the model's tool list on every turn; instead it
// registers here and only becomes visible once its skill is active.
//
// `skillCommand` is the skill's name as SkillsManager knows it (no leading
// slash — see skill-expansion.middleware.ts, which shares this same list so
// there's one source of truth for "which skills gate which tools").
//
// As of issue #409, the registration list is no longer a hardcoded array —
// it's derived live from each skill's own SKILL.md frontmatter `tools`
// field via resolveSkillGatedRegistrations() (skill-tool-gating.ts). This
// type is still the shared shape that pure helper produces and this
// middleware (plus the MCP half, skill-gated-mcp-tools.middleware.ts)
// consumes.
export interface SkillGatedToolRegistration {
  skillCommand: string;
  toolNames: string[];
}

// Shared by skill-expansion.middleware.ts (which writes this field), this
// middleware (which reads it), and skill-scoped-tools.middleware.ts (which
// also reads it, for the broader "any skill is active" gate rather than
// this middleware's exact-name match — see GLOSSARY.md § Skill Invocation &
// Runtime Access, Skill-Gated Tools vs Skill-Scoped Tools) — importing the
// same schema object, rather than each declaring an equivalent-looking one,
// keeps all three in sync by construction and is the one state channel they
// all register. Named activeSkill (not activeGatedSkill) because it's set
// for every resolved skill invocation, not only the ones with a Skill-Gated
// Tools registration (ADR-0019).
export const activeSkillStateSchema = z.object({
  activeSkill: z.string().nullable().default(null),
});

// getSkills defaults to the real production singleton, same pattern
// skill-expansion.middleware.ts already uses — a factory, not a bare
// accessor call baked in once, so bin/eval.ts and tests can inject a
// stand-in skill source instead of booting the real app's SkillsManager.
// Re-reads getSkills().list() fresh on every wrapModelCall rather than once
// at construction time: SkillsManager.list() is an in-memory cache read
// (cheap), and this is what makes an edit to a skill's `tools` field via
// the Settings UI take effect on the very next model call, no agent-cache
// bust or server restart needed (issue #409).
export function createSkillGatedToolsMiddleware(
  getSkills: () => Pick<SkillsManager, 'list'> = () => defaultSkillsManager,
) {
  return createMiddleware({
    name: 'SkillGatedToolsMiddleware',
    stateSchema: activeSkillStateSchema,
    wrapModelCall: async (request, handler) => {
      // Only the colon-free (built-in) half of each skill's declared tools
      // belongs here — a colon-containing entry is an MCP display id
      // (e.g. "n8n:workflow_search") and is handled entirely by the
      // separate skill-gated-mcp-tools.middleware.ts, which runs after
      // toolAccessMiddleware so it can ADD an MCP tool back in; this
      // middleware only ever FILTERS request.tools, it never adds, so it
      // must stay positioned (and scoped) exactly as it was before #409 —
      // see that file's own header comment for why the two can't be merged.
      const registrations = resolveSkillGatedRegistrations(getSkills().list()).map((r) => ({
        ...r,
        toolNames: r.toolNames.filter((name) => !name.includes(':')),
      }));
      const allGatedToolNames = new Set(registrations.flatMap((r) => r.toolNames));

      const activeSkill = request.state.activeSkill;
      const active = registrations.find((r) => r.skillCommand === activeSkill);
      const activeToolNames = new Set(active?.toolNames ?? []);

      const tools = request.tools.filter((tool) => {
        const name = tool.name as string;
        return !allGatedToolNames.has(name) || activeToolNames.has(name);
      });

      return handler({ ...request, tools });
    },
  });
}
