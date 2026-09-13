import { useTitle } from '@/hooks/use-title';
import { ToolAccessTable } from './tool-access-table';

// Web Fetch/RLM/Shell config used to live in three separate Cards here,
// backed by the batched settings form (useSettingsSection('tools')) —
// disconnected from the Tool Access list just above them, which already had
// its own row for each of those same tools. Both problems (disconnected
// config, and everything else about scanning this page) are fixed by moving
// per-tool config into each tool's own drawer instead — see
// tool-access-table.tsx / tool-settings-drawer.tsx.
//
// design: docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md
export function ToolsPanel() {
  useTitle('Settings - Tools');

  return (
    <div class="flex grow flex-col">
      <div class="flex-1 space-y-6 p-6">
        <ToolAccessTable />
      </div>
    </div>
  );
}
