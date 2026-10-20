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
    // Injects the Active Skill into toolCall.args rather than
    // runtime.configurable — confirmed via a real createAgent orchestration
    // test that mutating request.runtime here does NOT reach the actual
    // tool handler's runtime (LangGraph's ToolNode builds that fresh,
    // ignoring whatever wrapToolCall returns for that field); toolCall.args
    // is what the ToolNode actually invokes the tool with, so mutating it
    // here is what reaches the handler. The two tools' schemas use
    // .passthrough() so this extra key survives zod parsing without being
    // declared in the model-visible schema — the model is never told this
    // field exists and never supplies it, and even if it tried to, the
    // assignment below always overwrites it with the real server-side
    // value, last-write-wins. That's how "no arbitrary cross-skill file
    // access" is enforced by construction rather than convention.
    wrapToolCall: async (request, handler) => {
      if (!SKILL_SCOPED_TOOL_NAMES.has(request.toolCall.name)) return handler(request);
      return handler({
        ...request,
        toolCall: {
          ...request.toolCall,
          args: { ...request.toolCall.args, activeSkill: request.state.activeSkill },
        },
      });
    },
  });
}

export const skillScopedToolsMiddleware = createSkillScopedToolsMiddleware();
