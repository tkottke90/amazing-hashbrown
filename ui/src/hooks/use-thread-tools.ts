import { signal } from '@preact/signals';
import {
  fetchThreadTools,
  putThreadTools,
  resetThreadTools,
  type ThreadToolsResponse,
} from '@/services/tool-settings-api';
import { showToast } from '@/lib/toast';

// Controlled-signal drawer pattern, same as ui/src/hooks/use-skills-panel.ts —
// needed here because the drawer is opened from a DropdownMenuItem deep
// inside chat-input.tsx, which can't render its own trigger element in
// place the way McpServerDrawer's per-row trigger prop does.
//
// design: docs/superpowers/specs/2026-09-12-tool-management-ui-design.md §8

export const threadToolsDrawerOpen = signal(false);
export const threadToolsThreadId = signal<string | null>(null);
export const threadToolsData = signal<ThreadToolsResponse | null>(null);
export const threadToolsLoading = signal(false);
export const threadToolsSaving = signal(false);

export async function openThreadToolsDrawer(threadId: string): Promise<void> {
  threadToolsThreadId.value = threadId;
  threadToolsDrawerOpen.value = true;
  threadToolsLoading.value = true;
  try {
    threadToolsData.value = await fetchThreadTools(threadId);
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to load tool settings');
    threadToolsData.value = null;
  } finally {
    threadToolsLoading.value = false;
  }
}

// Closes the drawer and clears its state — called explicitly and by the
// drawer's own effect watching threadToolsDrawerOpen flip to false via any
// other close path (X button, Escape), same as use-skills-panel.ts's
// closeDrawer().
export function closeThreadToolsDrawer(): void {
  threadToolsDrawerOpen.value = false;
  threadToolsThreadId.value = null;
  threadToolsData.value = null;
}

export async function saveThreadTools(toolIds: string[]): Promise<boolean> {
  const threadId = threadToolsThreadId.value;
  if (!threadId) return false;
  threadToolsSaving.value = true;
  try {
    threadToolsData.value = await putThreadTools(threadId, toolIds);
    showToast('success', 'Tool selection saved');
    return true;
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to save tool selection');
    return false;
  } finally {
    threadToolsSaving.value = false;
  }
}

export async function resetThreadToolsToDefaults(): Promise<boolean> {
  const threadId = threadToolsThreadId.value;
  if (!threadId) return false;
  threadToolsSaving.value = true;
  try {
    threadToolsData.value = await resetThreadTools(threadId);
    showToast('success', 'Reset to defaults');
    return true;
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to reset tool selection');
    return false;
  } finally {
    threadToolsSaving.value = false;
  }
}

// Test-only: signals are module-level singletons, same reason
// resetSkillsPanelState exists for use-skills-panel.ts.
export function resetThreadToolsState(): void {
  threadToolsDrawerOpen.value = false;
  threadToolsThreadId.value = null;
  threadToolsData.value = null;
  threadToolsLoading.value = false;
  threadToolsSaving.value = false;
}
