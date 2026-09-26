export interface SkillInfo {
  name: string;
  slashCommand: string;
  description: string;
  // Which skill set it came from: 'global', or 'repo' for a workspace's
  // own .agents/skills. Only the workspace endpoint distinguishes them.
  source?: string;
  // A repo skill that replaces a global skill of the same name.
  overrides?: boolean;
}

// With a workspaceId, returns that workspace's view (global skills plus its
// .agents/skills); without one, the global skills only.
export async function fetchSkills(q: string, workspaceId?: string): Promise<SkillInfo[]> {
  const base = workspaceId
    ? `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/skills`
    : '/api/v1/skills';
  const res = await fetch(`${base}?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Skills fetch failed: ${res.status}`);
  const data = (await res.json()) as { skills: SkillInfo[] };
  return data.skills;
}
