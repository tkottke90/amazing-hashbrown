import { createMiddleware } from 'langchain';
import { activeSkillStateSchema } from './skill-gated-tools.middleware.js';

// Skill-Scoped Tools — tools visible whenever ANY skill is Active, resolving
// "which skill" from state.activeSkill rather than a model-supplied
// argument (GLOSSARY.md § Skill Invocation & Runtime Access). A different
// shape than Skill-Gated Tools (skill-gated-tools.middleware.ts), which ties
// one specific tool set to one specific named skill via a registration list
// — this middleware has a fixed, small tool-name set and no registration
// concept at all.
export const SKILL_SCOPED_TOOL_NAMES = new Set(['read_skill_reference', 'run_skill_script']);

export function createSkillScopedToolsMiddleware() {
  return createMiddleware({
    name: 'SkillScopedToolsMiddleware',
    stateSchema: activeSkillStateSchema,
    wrapModelCall: async (request, handler) => {
      const activeSkill = request.state.activeSkill;
      const tools = request.tools.filter((tool) => {
        const name = tool.name as string;
        return !SKILL_SCOPED_TOOL_NAMES.has(name) || activeSkill !== null;
      });
      return handler({ ...request, tools });
    },
    // Injects the Active Skill into runtime.configurable — the same
    // out-of-band channel existing tools already read workspaceId/thread_id
    // from — rather than into toolCall.args, so the model-visible zod schema
    // for read_skill_reference/run_skill_script never carries a skill-name
    // field at all. This is how "no arbitrary cross-skill file access" is
    // enforced by construction rather than convention: the tool handler
    // cannot be pointed at any skill but whichever one is actually Active.
    wrapToolCall: async (request, handler) => {
      if (!SKILL_SCOPED_TOOL_NAMES.has(request.toolCall.name)) return handler(request);
      return handler({
        ...request,
        runtime: {
          ...request.runtime,
          configurable: { ...request.runtime.configurable, activeSkill: request.state.activeSkill },
        },
      });
    },
  });
}

export const skillScopedToolsMiddleware = createSkillScopedToolsMiddleware();
