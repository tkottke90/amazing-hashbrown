import type { SkillSummary } from '@tkottke90/skills-manager';
import type { WorkspaceStore } from '../../services/workspace-store.js';
import { resolveWorkspaceSkills } from '../../services/workspace-skills.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';

// Same per-file ok/notFound helper convention as workspace-git.handlers.ts.
function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

// Enabled skills visible inside one workspace (global + its .agents/skills),
// optionally filtered by keyword — the workspace equivalent of GET /skills?q=.
export async function searchWorkspaceSkillsHandler(
  store: Pick<WorkspaceStore, 'getWorkspace'>,
  workspaceId: string,
  q?: string,
): Promise<HandlerResult<{ skills: SkillSummary[] }>> {
  const skills = await resolveWorkspaceSkills(workspaceId, { store });
  if (!skills) return notFound(`Workspace ${workspaceId} not found`);
  return ok({ skills: skills.search(q) });
}
