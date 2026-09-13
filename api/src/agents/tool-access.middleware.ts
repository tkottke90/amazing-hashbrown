import { createMiddleware } from 'langchain';
import { SystemMessage } from '@langchain/core/messages';
import {
  resolveEffectiveToolIds,
  ALWAYS_ON_TOOL_IDS,
  SKILL_GATED_TOOL_IDS,
} from './tool-access.js';
import { getToolInstructions } from './tool-config.js';
import { filterHarnessSections } from './system-prompt.js';
import { env, type ToolEntry } from '../config/env.js';
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
// design: docs/superpowers/specs/2026-09-12-tool-management-ui-design.md §6,
// docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md §3/§5
//
// A factory, not a bare singleton (same shape as createContextWindowMiddleware
// in chat-agent.ts) — takes an optional toolsConfig getter purely for
// testability, so a test can inject a plain object instead of writing a real
// config.yaml. Production code (chat-agent.ts) uses the default-exported
// toolAccessMiddleware singleton below, which reads the real env.tools.
export function createToolAccessMiddleware(
  getToolsConfig: () => Record<string, ToolEntry> = () => env.tools,
) {
  return createMiddleware({
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
      // enabled and unions in every alwaysOn tool — this IS the complete
      // effective set, nothing further to layer on top.
      let enabledIds: Set<string>;
      try {
        enabledIds = resolveEffectiveToolIds(threadId, getToolsConfig()).toolIds;
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

      // enabledIds is in display-id space (playwright:browser_click for MCP
      // tools) but bound tools carry boundName (playwright__browser_click) as
      // their LangChain .name — @tkottke90/tools-manager's mcpBoundName format,
      // applied at bind time in mcpToolToLangChain(). Convert each enabled id
      // to its matching bound-name form once here (never the other direction —
      // slugs are hyphen-only, so this forward conversion is unambiguous,
      // while parsing a bound name back into (slug, toolName) is not worth
      // relying on), keeping a lookup back to the original display id so
      // instruction injection below can key off it.
      const displayIdByMatchKey = new Map<string, string>();
      for (const id of enabledIds) {
        const colonIdx = id.indexOf(':');
        const matchKey =
          colonIdx === -1 ? id : `${id.slice(0, colonIdx)}__${id.slice(colonIdx + 1)}`;
        displayIdByMatchKey.set(matchKey, id);
      }

      const tools = request.tools.filter((tool) => {
        const name = tool.name as string;
        // Exempt, not merely "always included" — see SKILL_GATED_TOOL_IDS's
        // own doc comment for why this can't just be folded into enabledIds.
        if (SKILL_GATED_TOOL_IDS.has(name)) return true;
        return displayIdByMatchKey.has(name);
      });

      // Per-tool system-prompt instruction injection (issue #154): every
      // tool that survived the filter above, in display-id space (via the
      // same lookup used to filter it in), contributes its optional
      // instructions text — never baked into buildSystemPrompt() itself, for
      // the same dynamic-per-call reason the tool filtering above is
      // dynamic. A tool with no instructions set contributes nothing.
      const instructionBlocks = tools
        .map((tool) => {
          const displayId = displayIdByMatchKey.get(tool.name as string);
          if (!displayId) return null;
          const text = getToolInstructions(displayId, getToolsConfig()).trim();
          return text ? `<tool_guidance:${displayId}>\n${text}\n</tool_guidance>` : null;
        })
        .filter((block): block is string => block !== null);

      const baseContent = request.systemMessage.content;
      if (typeof baseContent !== 'string') {
        // Structured (non-string) system message content is not something
        // this app produces today (buildSystemPrompt() always returns a
        // plain string) — fail safe rather than risk corrupting it.
        logger.warn(
          'tool-access: systemMessage.content is not a string, skipping section filtering and instruction injection',
        );
        return handler({ ...request, tools });
      }

      // Gate tool-scoped harness sections (issue #154) on this call's actual
      // bound-tool set — must happen unconditionally here, not only when
      // instructionBlocks is non-empty below, or a thread with no per-tool
      // custom instructions set (the common case) would never have its
      // system message touched at all, silently defeating this filter.
      const filteredContent = filterHarnessSections(baseContent, enabledIds);

      if (instructionBlocks.length === 0) {
        return handler({ ...request, tools, systemMessage: new SystemMessage(filteredContent) });
      }

      const systemMessage = new SystemMessage(
        `${filteredContent}\n\n${instructionBlocks.join('\n\n')}`,
      );

      return handler({ ...request, tools, systemMessage });
    },
  });
}

export const toolAccessMiddleware = createToolAccessMiddleware();
