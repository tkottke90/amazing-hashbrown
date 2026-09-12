// Static inventory of every non-MCP tool the chat/workspace/task agents can
// bind, used by ToolSettingsStore (api/src/services/tool-settings-store.ts)
// to seed global defaults and by tool-access.middleware.ts to know which
// tools are exempt from filtering ("alwaysOn"). MCP tools are NOT listed
// here — they're discovered dynamically from ToolsManager and recorded into
// tool_settings by recordMcpDiscoveryResult() instead.
//
// `toolId` MUST equal the tool's real LangChain `.name` exactly — the
// tool-access middleware matches on bare tool name, so a mismatch here
// silently breaks filtering for that tool. See each tool's own
// `tools/*.tool.ts` file for the authoritative `name:` string.
//
// design: docs/superpowers/specs/2026-09-12-tool-management-ui-design.md §1

export type ToolCategory = 'built-in' | 'wiki' | 'skill-gated';

export interface CatalogEntry {
  toolId: string;
  name: string;
  description: string;
  category: ToolCategory;
  // Always available to every thread regardless of global/thread settings —
  // wiki tools per the design's "cannot disable wiki tools" requirement,
  // plus complete_task, which a task run needs to be able to call to
  // terminate at all (it isn't a user-facing choice the way the rest of
  // this catalog is).
  alwaysOn: boolean;
  // Set only for skill-gated entries — cross-references
  // GATED_SKILL_REGISTRATIONS's skillCommand, so the read-only UI row can
  // show which skill backs this tool.
  skillCommand?: string;
}

export const TOOL_CATALOG: CatalogEntry[] = [
  // ── Built-in ──────────────────────────────────────────────────────────
  {
    toolId: 'ask_user',
    name: 'Ask User',
    description: 'Ask the human user a question and pause until they respond.',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'upload_image',
    name: 'Upload Image',
    description: 'Attach a generated or fetched image to the conversation.',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'web_fetch',
    name: 'Web Fetch',
    description: 'Fetch and summarize the contents of a URL.',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'get_tool_key',
    name: 'Get Tool Key',
    description: 'Read a stored API key/credential value for use by another tool call.',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'rlm_query',
    name: 'RLM Query',
    description: 'Query the retrieval loop model for grounded, cited answers.',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'search_skills',
    name: 'Search Skills',
    description: 'Search installed skills by name or description.',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'search_conversation',
    name: 'Search Conversation',
    description: "Search this thread's own message history.",
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'spawn_sub_agent',
    name: 'Spawn Sub-Agent',
    description: 'Delegate a bounded sub-task to a fresh, read-only sub-agent run.',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'shell_exec',
    name: 'Shell Exec',
    description: 'Run a shell command, subject to the configured allow/denylist.',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'complete_task',
    name: 'Complete Task',
    description: 'Mark an automated task run as finished. Required for task runs to terminate.',
    category: 'built-in',
    alwaysOn: true,
  },

  // ── Wiki (always available — core to the platform) ───────────────────
  {
    toolId: 'wiki_search',
    name: 'Wiki Search',
    description: 'Search the wiki knowledge base.',
    category: 'wiki',
    alwaysOn: true,
  },
  {
    toolId: 'wiki_read_page',
    name: 'Wiki Read Page',
    description: 'Read a specific wiki page by path.',
    category: 'wiki',
    alwaysOn: true,
  },
  {
    toolId: 'wiki_locate',
    name: 'Wiki Locate',
    description: 'Locate which wiki domain a topic belongs to.',
    category: 'wiki',
    alwaysOn: true,
  },
  {
    toolId: 'wiki_orient',
    name: 'Wiki Orient',
    description: "Load a wiki domain's schema and recent activity log.",
    category: 'wiki',
    alwaysOn: true,
  },
  {
    toolId: 'wiki_lint',
    name: 'Wiki Lint',
    description: 'Check a wiki domain for structural/content issues.',
    category: 'wiki',
    alwaysOn: true,
  },
  {
    toolId: 'wiki_register_domain',
    name: 'Wiki Register Domain',
    description: 'Register an existing wiki domain for routing.',
    category: 'wiki',
    alwaysOn: true,
  },
  {
    toolId: 'wiki_create_page',
    name: 'Wiki Create Page',
    description: 'Create a new wiki page.',
    category: 'wiki',
    alwaysOn: true,
  },
  {
    toolId: 'wiki_update_page',
    name: 'Wiki Update Page',
    description: 'Update an existing wiki page.',
    category: 'wiki',
    alwaysOn: true,
  },
  {
    toolId: 'wiki_add_cross_link',
    name: 'Wiki Add Cross-Link',
    description: 'Add a cross-link between wiki domains.',
    category: 'wiki',
    alwaysOn: true,
  },
  {
    toolId: 'wiki_rebaseline_source',
    name: 'Wiki Rebaseline Source',
    description: "Refresh a wiki page's source-of-truth baseline.",
    category: 'wiki',
    alwaysOn: true,
  },

  // ── Skill-gated (informational only — see design §Scope) ─────────────
  {
    toolId: 'create_workspace',
    name: 'Create Workspace',
    description: 'Create a new workspace. Unlocked by the "create-workspace" skill.',
    category: 'skill-gated',
    alwaysOn: false,
    skillCommand: 'create-workspace',
  },
  {
    toolId: 'create_project',
    name: 'Create Project',
    description: 'Create a new project. Unlocked by the "create-project" skill.',
    category: 'skill-gated',
    alwaysOn: false,
    skillCommand: 'create-project',
  },
];
