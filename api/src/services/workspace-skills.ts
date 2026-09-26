import { join } from 'node:path';
import type { SkillsManager } from '@tkottke90/skills-manager';
import { logger } from '../config/logger.js';
import { GATED_SKILL_REGISTRATIONS } from '../agents/gated-skill-registrations.js';
import { skillsManager } from './skills-manager.js';
import { getWorkspaceStore, type WorkspaceStore } from './workspace-store.js';

// The read-only view of skills every consumer (slash-command expansion,
// search_skills, the workspace skills route) needs. Narrowed with Pick so no
// caller can reach write or script-execution methods — child managers reject
// those at runtime too.
export type SkillReader = Pick<SkillsManager, 'list' | 'search' | 'lookup'>;

// Where a workspace ships its own skills, relative to its directory.
export const WORKSPACE_SKILLS_DIR = join('.agents', 'skills');

export interface ResolveWorkspaceSkillsDeps {
  store?: Pick<WorkspaceStore, 'getWorkspace'>;
  manager?: SkillsManager;
}

// Resolves the skills visible inside one workspace: the global skills plus
// any the workspace directory ships under .agents/skills. Repo skills win on
// a name clash, except gated skill names, which stay global so a repo can
// never swap the instructions that run while a privileged tool is exposed.
//
// A fresh child manager is built on every call — nothing is cached — so git
// sync, branch checkout and hand edits are reflected immediately. Returns
// null when the workspace doesn't exist.
export async function resolveWorkspaceSkills(
  workspaceId: string,
  deps: ResolveWorkspaceSkillsDeps = {},
): Promise<SkillReader | null> {
  const store = deps.store ?? getWorkspaceStore();
  const manager = deps.manager ?? skillsManager;

  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return null;
  if (!workspace.location) return manager;

  const child = manager.createChild(join(workspace.location, WORKSPACE_SKILLS_DIR), {
    source: 'repo',
    reserved: GATED_SKILL_REGISTRATIONS.map((r) => r.skillCommand),
  });
  const { skipped } = await child.boot();
  for (const entry of skipped) {
    logger.warn('Workspace skill skipped', { workspaceId, ...entry });
  }
  return child;
}
