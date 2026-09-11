import { signal } from '@preact/signals';
import {
  fetchAllSkills,
  fetchSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  saveSkillFile,
  deleteSkillFile,
  fetchSkillEvals,
  saveSkillEvals,
  type SkillListItem,
  type SkillDetail,
  type CreateSkillInput,
  type EditSkillInput,
  type EvalSuite,
  type SkillFileDir,
} from '@/services/skills-manage-api';
import { showToast } from '@/lib/toast';

export const skillList = signal<SkillListItem[] | null>(null);
export const skillListLoading = signal(false);
export const skillListError = signal<string | null>(null);

export const selectedSkillName = signal<string | null>(null);
export const selectedSkill = signal<SkillDetail | null>(null);
export const selectedSkillLoading = signal(false);

// true -> main content area shows the create form instead of a selected skill
export const creatingSkill = signal(false);

export async function loadSkills(): Promise<void> {
  skillListLoading.value = true;
  try {
    skillList.value = await fetchAllSkills();
    skillListError.value = null;
  } catch (err) {
    skillListError.value = err instanceof Error ? err.message : 'Failed to load skills';
  } finally {
    skillListLoading.value = false;
  }
}

export async function selectSkill(name: string): Promise<void> {
  creatingSkill.value = false;
  selectedSkillName.value = name;
  selectedSkillLoading.value = true;
  try {
    selectedSkill.value = await fetchSkill(name);
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to load skill');
    selectedSkill.value = null;
  } finally {
    selectedSkillLoading.value = false;
  }
}

export function startCreateSkill(): void {
  selectedSkillName.value = null;
  selectedSkill.value = null;
  creatingSkill.value = true;
}

export function cancelCreateSkill(): void {
  creatingSkill.value = false;
}

export async function createSkillAction(input: CreateSkillInput): Promise<boolean> {
  try {
    const created = await createSkill(input);
    showToast('success', `Skill "${created.name}" created`);
    creatingSkill.value = false;
    await loadSkills();
    selectedSkillName.value = created.name;
    selectedSkill.value = created;
    return true;
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to create skill');
    return false;
  }
}

export async function saveSkillDetails(name: string, changes: EditSkillInput): Promise<boolean> {
  try {
    const updated = await updateSkill(name, changes);
    selectedSkill.value = updated;
    showToast('success', 'Skill saved');
    await loadSkills();
    return true;
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to save skill');
    return false;
  }
}

export async function toggleSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const previous = skillList.value;
  // Optimistic flip so the switch responds immediately.
  if (previous) {
    skillList.value = previous.map((s) => (s.name === name ? { ...s, enabled } : s));
  }
  if (selectedSkill.value?.name === name) {
    selectedSkill.value = { ...selectedSkill.value, enabled };
  }
  try {
    await updateSkill(name, { enabled });
  } catch (err) {
    if (previous) skillList.value = previous;
    if (selectedSkill.value?.name === name) {
      selectedSkill.value = { ...selectedSkill.value, enabled: !enabled };
    }
    showToast('error', err instanceof Error ? err.message : 'Failed to update skill');
  }
}

export async function deleteSkillAction(name: string): Promise<boolean> {
  try {
    await deleteSkill(name);
    showToast('success', `Skill "${name}" deleted`);
    if (selectedSkillName.value === name) {
      selectedSkillName.value = null;
      selectedSkill.value = null;
    }
    await loadSkills();
    return true;
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to delete skill');
    return false;
  }
}

async function refreshSelectedSkill(name: string): Promise<void> {
  try {
    selectedSkill.value = await fetchSkill(name);
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to refresh skill');
  }
}

export async function saveSkillFileAction(
  name: string,
  dir: SkillFileDir,
  basename: string,
  content: string,
): Promise<boolean> {
  try {
    await saveSkillFile(name, dir, basename, content);
    showToast('success', `Saved ${basename}`);
    await refreshSelectedSkill(name);
    return true;
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to save file');
    return false;
  }
}

export async function deleteSkillFileAction(
  name: string,
  dir: SkillFileDir,
  basename: string,
): Promise<boolean> {
  try {
    await deleteSkillFile(name, dir, basename);
    showToast('success', `Deleted ${basename}`);
    await refreshSelectedSkill(name);
    return true;
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to delete file');
    return false;
  }
}

export async function loadEvalsAction(name: string): Promise<EvalSuite | null> {
  try {
    return await fetchSkillEvals(name);
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to load evals');
    return null;
  }
}

export async function saveEvalsAction(name: string, suite: EvalSuite): Promise<boolean> {
  try {
    await saveSkillEvals(name, suite);
    showToast('success', 'Evals saved');
    return true;
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : 'Failed to save evals');
    return false;
  }
}

// Test-only: signals are module-level singletons, same reason
// resetWorkspaceFilesState exists for use-workspace-files.ts.
export function resetSkillsPanelState(): void {
  skillList.value = null;
  skillListLoading.value = false;
  skillListError.value = null;
  selectedSkillName.value = null;
  selectedSkill.value = null;
  selectedSkillLoading.value = false;
  creatingSkill.value = false;
}
