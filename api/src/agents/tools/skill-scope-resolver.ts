import { join } from 'node:path';
import { SkillsManager } from '@tkottke90/skills-manager';
import { skillsManager } from '../../services/skills-manager.js';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import { WORKSPACE_SKILLS_DIR } from '../../services/workspace-skills.js';

// Five of the nine create-skill tools (get_skill_source and the four
// skill-artifact tools) take just a skill name, with no explicit scope —
// they all need the identical "check app scope, check workspace scope, use
// whichever one actually has it, else ask to disambiguate" resolution.
// Factored once here rather than once per tool (AGENTS.md § Composition
// over Customization).
//
// Deliberately NOT built on resolveWorkspaceSkills()'s read-only child
// manager (services/workspace-skills.ts) — that manager's assertWritable()
// throws on every write/script method, so a tool that needs to write
// through the resolved manager (create/update/delete/test artifact calls)
// needs a separate, plainly-constructed, writable SkillsManager rooted at
// the same directory instead.

export type SkillScopeResolution =
  | { kind: 'found'; manager: SkillsManager; scope: 'app' | 'workspace' }
  | { kind: 'ambiguous' }
  | { kind: 'not-found' };

export interface ResolveSkillScopeDeps {
  globalManager?: SkillsManager;
  store?: Pick<WorkspaceStore, 'getWorkspace'>;
}

export async function resolveSkillScope(
  skill: string,
  workspaceId: string | undefined,
  deps: ResolveSkillScopeDeps = {},
): Promise<SkillScopeResolution> {
  const globalManager = deps.globalManager ?? skillsManager;
  const globalInspection = await globalManager.inspect(skill);

  let workspaceManager: SkillsManager | undefined;
  let workspaceExists = false;
  if (workspaceId) {
    const store = deps.store ?? getWorkspaceStore();
    const workspace = store.getWorkspace(workspaceId);
    if (workspace?.location) {
      workspaceManager = new SkillsManager(join(workspace.location, WORKSPACE_SKILLS_DIR));
      workspaceExists = (await workspaceManager.inspect(skill)).exists;
    }
  }

  if (globalInspection.exists && workspaceExists) return { kind: 'ambiguous' };
  if (globalInspection.exists) return { kind: 'found', manager: globalManager, scope: 'app' };
  if (workspaceExists && workspaceManager) {
    return { kind: 'found', manager: workspaceManager, scope: 'workspace' };
  }
  return { kind: 'not-found' };
}
