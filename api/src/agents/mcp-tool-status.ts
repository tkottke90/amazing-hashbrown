// Syncs ToolsManager's current in-memory view of MCP tools/server statuses
// into ToolSettingsStore. Deliberately does NOT itself trigger a fetch —
// callers decide whether to force one first:
//   - loadMcpTools() (chat-agent.ts) calls this after its existing
//     toolsManager.getTools() call, which only actually re-fetches on the
//     first call ever (or after an MCP server config change) — so this
//     write-through is just as infrequent, not a per-turn DB write.
//   - the POST /tool-settings/refresh handler calls
//     toolsManager.refreshMcpTools() first (bypassing that cache) and then
//     this, since a refresh is an explicit ask for a live check.
//
// design: docs/superpowers/specs/2026-09-12-tool-management-ui-design.md §2

import type { ToolsManager } from '@tkottke90/tools-manager';
import type { ToolSettingsStore } from '../services/tool-settings-store.js';

export function syncMcpToolStatus(manager: ToolsManager, store: ToolSettingsStore): void {
  const statuses = manager.getMcpServerStatuses();
  // Empty until the first fetch has actually run (see
  // ToolsManager.getMcpServerStatuses()'s own doc comment) — nothing to
  // record yet, and recording nothing is correct here, not an error.
  if (statuses.size === 0) return;

  const mcpTools = manager
    .list()
    .filter((t) => t.source === 'mcp')
    .map((t) => ({ name: t.name, description: t.description, mcpServer: t.mcpServer! }));

  store.recordMcpDiscoveryResult(mcpTools, statuses);
}
