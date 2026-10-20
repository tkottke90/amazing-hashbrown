import { createMiddleware } from 'langchain';
import { z } from 'zod';

// Reusable "Skill-Gated Tools" pattern — see AGENTS.md § Composition over
// Customization and README.md § Design philosophy: context is scarce. A
// tool that's only useful once a specific slash-command skill has been
// invoked shouldn't sit in the model's tool list on every turn; instead it
// registers here and only becomes visible once its skill is active.
//
// `skillCommand` is the skill's name as SkillsManager knows it (no leading
// slash — see skill-expansion.middleware.ts, which shares this same list so
// there's one source of truth for "which skills gate which tools").
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

export function createSkillGatedToolsMiddleware(registrations: SkillGatedToolRegistration[]) {
  const allGatedToolNames = new Set(registrations.flatMap((r) => r.toolNames));

  return createMiddleware({
    name: 'SkillGatedToolsMiddleware',
    stateSchema: activeSkillStateSchema,
    wrapModelCall: async (request, handler) => {
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
