import { createMiddleware } from 'langchain';
import { resolveEffectiveToolIds, ALWAYS_ON_TOOL_IDS, SKILL_GATED_TOOL_IDS } from './tool-access.js';
import { logger, serializeError } from '../config/logger.js';

// Per-thread/global tool enable-disable enforcement (issue #171). Reads the
// current thread id fresh on every model call via request.runtime.configurable
// — NOT baked into a Set closed over at agent-build time — because
// getChatAgent()/getWorkspaceChatAgent() cache built agents keyed by
// provider:model (or workspaceId:provider:model), not by thread. Baking a
// thread's tool selection in at build time would leak one thread's
// selection into every other thread sharing that cache key the next time
// the cached agent is reused. Confirmed against langchain@1.5.2's own
// published types (ModelRequest.runtime: Runtime<TContext>; Runtime.configurable?.thread_id)
// that wrapModelCall's request genuinely carries this, the same runtime
// object afterAgentMiddleware already reads thread_id from below.
//
// Module-scoped singleton, like skillGatedToolsMiddleware — no stateSchema
// needed since nothing here is graph state, just an external store lookup.
//
// Skill-gated tools (create_workspace, create_project) are explicitly
// EXEMPT from the enabled/effective-set check below (see SKILL_GATED_TOOL_IDS),
// not merely "happen to pass it" — their actual turn-scoped availability
// remains entirely governed by skillGatedToolsMiddleware/activeGatedSkill,
// which runs earlier in the middleware array and has already removed an
// inactive one from request.tools by the time this middleware sees it. A
// thread's tool_tools snapshot never contains a skill-gated id (the drawer
// shows them read-only, no checkbox), so without this exemption an ACTIVE
// gated tool would get wrongly stripped back out the moment any thread got
// customized.
//
// design: docs/superpowers/specs/2026-09-12-tool-management-ui-design.md §6
export const toolAccessMiddleware = createMiddleware({
  name: 'ToolAccessMiddleware',
  wrapModelCall: async (request, handler) => {
    const threadId = request.runtime.configurable?.thread_id;

    // No thread id in scope (e.g. the startup warm-up agent build in
    // index.ts, which opens MCP connections early but never actually turns
    // a real conversation) — nothing to filter against, so every tool that
    // reached this point is bound as-is. Filtering requires a thread to
    // filter FOR; there's no sensible default to fall back to here.
    if (!threadId) return handler(request);

    // resolveEffectiveToolIds() already intersects with what's globally
    // enabled (both its non-customized and customized branches query
    // tool_settings with `enabled = 1`) and unions in every alwaysOn tool —
    // this IS the complete effective set, nothing further to layer on top.
    let enabledIds: Set<string>;
    try {
      enabledIds = resolveEffectiveToolIds(threadId).toolIds;
    } catch (err) {
      // Fail CLOSED to just the always-on set — a tool-settings bug must
      // never take down chat entirely, but it also must never silently
      // grant every tool either. Wiki tools and complete_task keep
      // working; nothing else does until the underlying issue is fixed.
      logger.warn('tool-access: failed to resolve effective tool ids, using always-on set only', {
        threadId,
        err: serializeError(err as Error),
      });
      enabledIds = ALWAYS_ON_TOOL_IDS;
    }

    const tools = request.tools.filter((tool) => {
      const name = tool.name as string;
      // Exempt, not merely "always included" — see SKILL_GATED_TOOL_IDS's
      // own doc comment for why this can't just be folded into enabledIds.
      if (SKILL_GATED_TOOL_IDS.has(name)) return true;
      return enabledIds.has(name);
    });

    return handler({ ...request, tools });
  },
});
