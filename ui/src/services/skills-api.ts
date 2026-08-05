export interface SkillInfo {
  name: string;
  slashCommand: string;
  description: string;
}

export async function fetchSkills(q: string): Promise<SkillInfo[]> {
  const res = await fetch(`/api/v1/skills?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Skills fetch failed: ${res.status}`);
  const data = (await res.json()) as { skills: SkillInfo[] };
  return data.skills;
}
