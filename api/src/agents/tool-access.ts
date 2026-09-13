// Shared "what tools can this thread actually use right now" resolver —
// the single source of truth both tool-access.middleware.ts (enforcement)
// and threads.handlers.ts (GET/PUT/DELETE /threads/:id/tools) read from, so
// the two can never drift apart on what "effective" means.
//
// design: docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md §3

import { getThreadStore } from '../services/thread-store.js';
import { getToolSettingsStore } from '../services/tool-settings-store.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import { getGlobalDefaultToolIds, getGloballyEnabledToolIds } from './tool-config.js';
import { env, type ToolEntry } from '../config/env.js';

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

// toolsConfig defaults to the real config.yaml-backed singleton (env.tools);
// accepted as an optional override purely for testability, same rationale
// as tool-config.ts's own functions.
export function resolveEffectiveToolIds(
  threadId: string,
  toolsConfig: Record<string, ToolEntry> = env.tools,
): EffectiveToolIds {
  const thread = getThreadStore().getThreadMeta(threadId);
  const customized = thread?.toolsCustomizedAt != null;
  // getThreadToolIds() returns the thread's raw stored snapshot, unfiltered —
  // "enabled" now lives in config.yaml (tool-config.ts), not the SQLite
  // table, so a tool disabled globally after the snapshot was taken must be
  // intersected out here to keep "global disabled makes it unavailable in
  // all threads" true (design §3).
  const baseIds = customized
    ? new Set(
        [...getToolSettingsStore().getThreadToolIds(threadId)].filter((id) =>
          getGloballyEnabledToolIds(toolsConfig).has(id),
        ),
      )
    : getGlobalDefaultToolIds(toolsConfig);
  return { customized, toolIds: new Set([...baseIds, ...ALWAYS_ON_TOOL_IDS]) };
}
