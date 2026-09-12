// Shared "what tools can this thread actually use right now" resolver —
// the single source of truth both tool-access.middleware.ts (enforcement)
// and threads.handlers.ts (GET/PUT/DELETE /threads/:id/tools) read from, so
// the two can never drift apart on what "effective" means.
//
// design: docs/superpowers/specs/2026-09-12-tool-management-ui-design.md §3

import { getThreadStore } from '../services/thread-store.js';
import { getToolSettingsStore } from '../services/tool-settings-store.js';
import { TOOL_CATALOG } from './tool-catalog.js';

export const ALWAYS_ON_TOOL_IDS = new Set(
  TOOL_CATALOG.filter((entry) => entry.alwaysOn).map((entry) => entry.toolId),
);

// Skill-gated tools are exempt from tool-access filtering entirely — their
// actual per-turn availability is governed solely by
// skillGatedToolsMiddleware/activeGatedSkill (turn-scoped: present only
// when the matching slash command was just typed), which already runs
// earlier in the middleware chain and has already removed an inactive
// gated tool from request.tools by the time tool-access.middleware.ts sees
// it. If tool-access filtering also applied here, a user's thread-tools
// snapshot (which never includes a skill-gated id — the drawer shows them
// read-only, with no checkbox to select) would wrongly strip an ACTIVE
// gated tool back out the moment any thread got customized. See design
// §Scope: "toggling them has no runtime effect" — this is that guarantee's
// enforcement-side counterpart.
export const SKILL_GATED_TOOL_IDS = new Set(
  TOOL_CATALOG.filter((entry) => entry.category === 'skill-gated').map((entry) => entry.toolId),
);

export interface EffectiveToolIds {
  // Whether this thread has its own thread_tools snapshot (true) or is
  // still tracking global defaults live (false) — threads.tools_customized_at
  // IS NOT NULL, per design §3.
  customized: boolean;
  // The full set this thread's turns are allowed to bind, already unioned
  // with every alwaysOn catalog tool (wiki tools, complete_task) regardless
  // of stored settings.
  toolIds: Set<string>;
}

export function resolveEffectiveToolIds(threadId: string): EffectiveToolIds {
  const thread = getThreadStore().getThreadMeta(threadId);
  const customized = thread?.toolsCustomizedAt != null;
  const store = getToolSettingsStore();
  const baseIds = customized ? store.getThreadToolIds(threadId) : store.getGlobalDefaultToolIds();
  return { customized, toolIds: new Set([...baseIds, ...ALWAYS_ON_TOOL_IDS]) };
}
