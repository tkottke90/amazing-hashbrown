import { createMiddleware } from 'langchain';
import type { ClientTool } from '@langchain/core/tools';
import type { SkillsManager } from '@tkottke90/skills-manager';
import { skillsManager as defaultSkillsManager } from '../services/skills-manager.js';
import { resolveSkillGatedRegistrations } from './skill-tool-gating.js';
import { activeSkillStateSchema } from './skill-gated-tools.middleware.js';
import { getGloballyEnabledToolIds, toBoundMatchKeys } from './tool-config.js';
import { env, type ToolEntry } from '../config/env.js';

// The MCP half of Skill-Gated Tools (issue #409) — a skill's own `tools`
// frontmatter field can declare an MCP tool (display-id form, e.g.
// "n8n:workflow_search") alongside built-in names. Unlike the built-in half
// (skill-gated-tools.middleware.ts), this one can only ever ADD a tool to
// request.tools, never remove one, so it has to run AFTER
// toolAccessMiddleware — the opposite ordering requirement from the
// built-in half, which must keep running BEFORE it (see that file's own
// header comment for the correction found while designing this: moving the
// built-in filter after toolAccessMiddleware would break
// tool-access.middleware.ts's own boundIds/#tool-name/filterHarnessSections
// logic). That's why this is a separate middleware rather than a second
// mode bolted onto the existing one. Positioned in chat-agent.ts right next
// to createMcpToolDiscoveryMiddleware (mcp-tool-discovery.middleware.ts),
// which solves the identical "add an MCP tool back in after
// toolAccessMiddleware's filtering" problem for the ad hoc discovery path —
// order between the two doesn't matter, both only add.
//
// A skill-gated MCP tool binds directly the instant its skill is Active —
// no search_mcp_tools/use_mcp_tools round-trip, unlike a Discovered Tool
// (GLOSSARY.md § MCP Tool Discovery) — EXCEPT that an admin's explicit
// disable still wins (ADR-0071), checked here via
// getGloballyEnabledToolIds(): the same global-only check
// use_mcp_tools/search_mcp_tools already use, deliberately not
// resolveEffectiveToolIds(threadId) — intersecting with a thread's
// customized snapshot would wrongly require the tool already be in that
// thread's own selection, defeating "direct bind, no round-trip."
export function createSkillGatedMcpToolsMiddleware(
  mcpTools: ClientTool[],
  getSkills: () => Pick<SkillsManager, 'list'> = () => defaultSkillsManager,
  getToolsConfig: () => Record<string, ToolEntry> = () => env.tools,
) {
  // Keyed by boundName (mcpTools' own .name) — the same forward-only
  // colon-to-double-underscore conversion toBoundMatchKeys() and
  // createMcpToolDiscoveryMiddleware already use. Never parse a boundName
  // back into a display id.
  const byBoundName = new Map(mcpTools.map((t) => [t.name as string, t]));

  return createMiddleware({
    name: 'SkillGatedMcpToolsMiddleware',
    stateSchema: activeSkillStateSchema,
    wrapModelCall: async (request, handler) => {
      const activeSkill = request.state.activeSkill;
      if (!activeSkill) return handler(request);

      const registrations = resolveSkillGatedRegistrations(getSkills().list());
      const active = registrations.find((r) => r.skillCommand === activeSkill);
      if (!active) return handler(request);

      const mcpDisplayIds = active.toolNames.filter((name) => name.includes(':'));
      if (mcpDisplayIds.length === 0) return handler(request);

      // ADR-0071: an admin's explicit disable still wins over the gate.
      const enabledIds = getGloballyEnabledToolIds(getToolsConfig());
      const allowedDisplayIds = new Set(mcpDisplayIds.filter((id) => enabledIds.has(id)));
      if (allowedDisplayIds.size === 0) return handler(request);

      const boundSet = new Set(request.tools.map((t) => t.name as string));
      const additions = [...toBoundMatchKeys(allowedDisplayIds)]
        .map((boundName) => byBoundName.get(boundName))
        .filter((t): t is ClientTool => t !== undefined && !boundSet.has(t.name as string));

      if (additions.length === 0) return handler(request);
      return handler({ ...request, tools: [...request.tools, ...additions] });
    },
  });
}
