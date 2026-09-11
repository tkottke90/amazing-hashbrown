// Admin/management client for the Skills settings panel. Kept independent
// from ui/src/services/skills-api.ts (the narrower, enabled-only contract
// used by the chat slash-command autocomplete) — separate concerns, per the
// design doc.

export interface SkillListItem {
  name: string;
  description: string;
  slashCommand: string;
  enabled: boolean;
  largeDesc: boolean;
  // Only populated on the admin (`all=true`) listing — absent on the plain
  // `q=` search response used by the chat slash-command autocomplete.
  hasScripts?: boolean;
  hasReferences?: boolean;
  hasEvals?: boolean;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
}

export interface SkillDetail {
  name: string;
  slashCommand: string;
  enabled: boolean;
  path: string;
  frontmatter: SkillFrontmatter;
  body: string;
  scripts: Record<string, string>;
  references: Record<string, string>;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface EditSkillInput {
  description?: string;
  body?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  enabled?: boolean;
}

export interface EvalCase {
  id: number | string;
  prompt: string;
  expected_output: string;
  files?: string[];
  assertions?: string[];
}

export interface EvalSuite {
  skill_name: string;
  evals: EvalCase[];
}

export type SkillFileDir = 'scripts' | 'references';

export class SkillsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'SkillsApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new SkillsApiError(body.error ?? `Request failed: ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

function skillUrl(name: string): string {
  return `/api/v1/skills/${encodeURIComponent(name)}`;
}

function fileUrl(name: string, dir: SkillFileDir, basename: string): string {
  return `${skillUrl(name)}/files/${dir}/${encodeURIComponent(basename)}`;
}

export async function fetchAllSkills(): Promise<SkillListItem[]> {
  const { skills } = await request<{ skills: SkillListItem[] }>('/api/v1/skills?all=true');
  return skills;
}

export async function fetchSkill(name: string): Promise<SkillDetail> {
  return request<SkillDetail>(skillUrl(name));
}

export async function createSkill(input: CreateSkillInput): Promise<SkillDetail> {
  return request<SkillDetail>('/api/v1/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateSkill(name: string, changes: EditSkillInput): Promise<SkillDetail> {
  return request<SkillDetail>(skillUrl(name), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
}

export async function deleteSkill(name: string): Promise<void> {
  await request<{ deleted: true }>(skillUrl(name), { method: 'DELETE' });
}

export async function fetchSkillFile(
  name: string,
  dir: SkillFileDir,
  basename: string,
): Promise<string> {
  const { content } = await request<{ content: string }>(fileUrl(name, dir, basename));
  return content;
}

export async function saveSkillFile(
  name: string,
  dir: SkillFileDir,
  basename: string,
  content: string,
): Promise<void> {
  await request<{ saved: true }>(fileUrl(name, dir, basename), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

export async function deleteSkillFile(
  name: string,
  dir: SkillFileDir,
  basename: string,
): Promise<void> {
  await request<{ deleted: true }>(fileUrl(name, dir, basename), { method: 'DELETE' });
}

export async function fetchSkillEvals(name: string): Promise<EvalSuite> {
  return request<EvalSuite>(`${skillUrl(name)}/evals`);
}

export async function saveSkillEvals(name: string, suite: EvalSuite): Promise<void> {
  await request<{ saved: true }>(`${skillUrl(name)}/evals`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(suite),
  });
}
