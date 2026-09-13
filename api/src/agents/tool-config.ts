// The tool-settings resolver — the one module everything in the tool
// settings redesign reads "is this tool enabled / included by default /
// what does it say" from. config.yaml (via env.tools) is the source of
// truth for every user-editable field; TOOL_CATALOG supplies the built-in/
// wiki/skill-gated defaults, and ToolSettingsStore's SQLite table supplies
// MCP discovery identity (which MCP tools currently exist, their
// as-discovered name/description). This module merges the three into one
// coherent view and is deliberately read-only — writes go through
// tool-settings.handlers.ts directly into config.yaml.
//
// design: docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md §3

import { env, type ToolEntry } from '../config/env.js';
import { TOOL_CATALOG, type ToolCategory } from './tool-catalog.js';
import {
  getToolSettingsStore,
  type ToolSettingsStore,
  type ToolSettingRow,
} from '../services/tool-settings-store.js';

// Today's exact SUB_AGENT_TOOLS membership (chat-agent.ts, pre-redesign) —
// kept only as the default-seed list for defaultInclude.subAgent, so an
// unedited config.yaml reproduces today's sub-agent tool set exactly. Not
// an enforcement allowlist anymore; see getSubAgentToolIds() below.
const LEGACY_SUB_AGENT_TOOL_IDS = new Set([
  'wiki_search',
  'wiki_read_page',
  'wiki_locate',
  'wiki_orient',
  'wiki_lint',
  'web_fetch',
  'get_tool_key',
  'rlm_query',
  'search_skills',
  'search_conversation',
]);

// Tools that are structurally incompatible with a sub-agent run, not just
// "risky" — ask_user's interrupt() has nothing watching to resume it in a
// sub-agent run (hangs), and spawn_sub_agent has no nesting-depth guard, so
// allowing it would let a sub-agent spawn another sub-agent unbounded.
// Hard-excluded here (never toggleable, regardless of config.yaml), not
// merely defaulted off.
const SUB_AGENT_HARD_EXCLUDED_IDS = new Set(['ask_user', 'spawn_sub_agent']);

export interface ResolvedDefaultInclude {
  chat: boolean;
  subAgent: boolean;
  autonomous: boolean;
}

export interface ResolvedToolSettingItem {
  toolId: string;
  name: string;
  description: string;
  category: ToolCategory | 'mcp';
  alwaysOn: boolean;
  mcpServer: string | null;
  lastSeenAt: string | null;
  lastStatus: ToolSettingRow['lastStatus'];
  enabled: boolean;
  defaultInclude: ResolvedDefaultInclude;
  instructions: string;
  // Tool-specific extra fields for web_fetch/rlm_query/shell_exec, carried
  // through as-is from config.yaml's catchall — everything else has none.
  [extra: string]: unknown;
}

interface CatalogDefaults {
  toolId: string;
  name: string;
  description: string;
  category: ToolCategory | 'mcp';
  alwaysOn: boolean;
  mcpServer: string | null;
  lastSeenAt: string | null;
  lastStatus: ToolSettingRow['lastStatus'];
}

// toolsConfig defaults to the real config.yaml-backed singleton
// (env.tools); every function below accepts it as an optional last
// parameter purely for testability — tests pass a plain object literal
// instead of writing a real config.yaml, no config-manager stubbing needed.
export function getStoredToolEntry(
  toolId: string,
  toolsConfig: Record<string, ToolEntry> = env.tools,
): ToolEntry | undefined {
  return toolsConfig[toolId];
}

export function resolveToolSettings(
  base: CatalogDefaults,
  toolsConfig: Record<string, ToolEntry> = env.tools,
): ResolvedToolSettingItem {
  const stored = getStoredToolEntry(base.toolId, toolsConfig);

  // alwaysOn catalog tools (wiki tools, complete_task) are forced on
  // regardless of what's stored — same rule the drawer/PATCH handler
  // enforce (docs .../design.md §3, §6 "Global tool-settings API").
  const enabled = base.alwaysOn ? true : (stored?.enabled ?? true);
  const defaultInclude: ResolvedDefaultInclude = base.alwaysOn
    ? { chat: true, subAgent: true, autonomous: true }
    : {
        chat: stored?.defaultInclude?.chat ?? true,
        subAgent: stored?.defaultInclude?.subAgent ?? LEGACY_SUB_AGENT_TOOL_IDS.has(base.toolId),
        autonomous: stored?.defaultInclude?.autonomous ?? true,
      };

  const KNOWN_FIELDS = new Set(['enabled', 'defaultInclude', 'description', 'instructions']);
  const extra = Object.fromEntries(
    Object.entries(stored ?? {}).filter(([key]) => !KNOWN_FIELDS.has(key)),
  );

  return {
    ...extra,
    toolId: base.toolId,
    name: base.name,
    description: stored?.description ?? base.description,
    category: base.category,
    alwaysOn: base.alwaysOn,
    mcpServer: base.mcpServer,
    lastSeenAt: base.lastSeenAt,
    lastStatus: base.lastStatus,
    enabled,
    defaultInclude,
    instructions: stored?.instructions ?? '',
  };
}

function catalogDefaultsFor(entry: (typeof TOOL_CATALOG)[number]): CatalogDefaults {
  return {
    toolId: entry.toolId,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    alwaysOn: entry.alwaysOn,
    mcpServer: null,
    lastSeenAt: null,
    lastStatus: null,
  };
}

function mcpDefaultsFor(row: ToolSettingRow): CatalogDefaults {
  return {
    toolId: row.toolId,
    name: row.name,
    description: row.description,
    category: 'mcp',
    alwaysOn: false,
    mcpServer: row.mcpServer,
    lastSeenAt: row.lastSeenAt,
    lastStatus: row.lastStatus,
  };
}

// The single canonical "every tool the app knows about, fully resolved"
// list — feeds both GET /api/v1/tool-settings (the table) and
// threads.handlers.ts's computeThreadTools (the per-thread drawer). Both
// halves are injectable purely for testability, defaulting to the real
// singletons: toolsConfig to env.tools, store to getToolSettingsStore() (so
// a test that already constructs its own standalone ToolSettingsStore, e.g.
// threads.handlers.test.ts's makeToolsStores(), doesn't have to also boot
// the app's global singleton just to exercise this).
export function listResolvedToolSettings(
  toolsConfig: Record<string, ToolEntry> = env.tools,
  store: ToolSettingsStore = getToolSettingsStore(),
): ResolvedToolSettingItem[] {
  const catalogItems = TOOL_CATALOG.map((entry) =>
    resolveToolSettings(catalogDefaultsFor(entry), toolsConfig),
  );
  const mcpItems = store.list().map((row) => resolveToolSettings(mcpDefaultsFor(row), toolsConfig));
  return [...catalogItems, ...mcpItems];
}

export function getGlobalDefaultToolIds(
  toolsConfig: Record<string, ToolEntry> = env.tools,
  store: ToolSettingsStore = getToolSettingsStore(),
): Set<string> {
  return new Set(
    listResolvedToolSettings(toolsConfig, store)
      .filter((t) => t.enabled && t.defaultInclude.chat)
      .map((t) => t.toolId),
  );
}

export function getGloballyEnabledToolIds(
  toolsConfig: Record<string, ToolEntry> = env.tools,
  store: ToolSettingsStore = getToolSettingsStore(),
): Set<string> {
  return new Set(
    listResolvedToolSettings(toolsConfig, store)
      .filter((t) => t.enabled)
      .map((t) => t.toolId),
  );
}

// Never includes SUB_AGENT_HARD_EXCLUDED_IDS, regardless of config.yaml —
// enforced here at the source so no future call site can bind them by
// forgetting to re-filter.
export function getSubAgentToolIds(
  toolsConfig: Record<string, ToolEntry> = env.tools,
  store: ToolSettingsStore = getToolSettingsStore(),
): Set<string> {
  return new Set(
    listResolvedToolSettings(toolsConfig, store)
      .filter(
        (t) => t.enabled && t.defaultInclude.subAgent && !SUB_AGENT_HARD_EXCLUDED_IDS.has(t.toolId),
      )
      .map((t) => t.toolId),
  );
}

export function getToolInstructions(
  toolId: string,
  toolsConfig: Record<string, ToolEntry> = env.tools,
): string {
  return getStoredToolEntry(toolId, toolsConfig)?.instructions ?? '';
}

// A display id (config.yaml key, e.g. playwright:browser_click) is what
// every tool-config.ts function above deals in, but what's actually bound
// to the model — a LangChain tool's real .name — is the boundName form
// (playwright__browser_click) for MCP tools, since tool-calling APIs reject
// colons. Converts every id in a Set to its matching bound form in one
// direction only (forward: colon -> double-underscore) — slugs are
// hyphen-only (slugifyServerName), so this is unambiguous; parsing a bound
// name back into (slug, toolName) is deliberately never relied on anywhere.
// Shared by tool-access.middleware.ts's filter and buildSubAgentAgent's.
export function toBoundMatchKeys(ids: Set<string>): Set<string> {
  const keys = new Set<string>();
  for (const id of ids) {
    const colonIdx = id.indexOf(':');
    keys.add(colonIdx === -1 ? id : `${id.slice(0, colonIdx)}__${id.slice(colonIdx + 1)}`);
  }
  return keys;
}
