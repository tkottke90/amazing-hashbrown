import matter from 'gray-matter';
import type { SkillFrontmatter } from '../types.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const NAME_MAX = 64;

export interface ParsedSkill {
  data: Record<string, unknown>;
  body: string;
}

export function parse(raw: string): ParsedSkill {
  const { data, content } = matter(raw);
  return { data, body: content };
}

export function serialize(frontmatter: SkillFrontmatter, body: string): string {
  const data: Record<string, unknown> = { ...frontmatter };
  return matter.stringify(body.replace(/^\n+/, ''), data);
}

export function validateFrontmatter(data: Record<string, unknown>): SkillFrontmatter {
  const name = data['name'];
  const description = data['description'];

  if (typeof name !== 'string' || !name) {
    throw new Error('SKILL.md missing required field: name');
  }
  if (name.length > NAME_MAX || !NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}": must match /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ and be ≤${NAME_MAX} chars`
    );
  }
  if (typeof description !== 'string' || !description) {
    throw new Error('SKILL.md missing required field: description');
  }

  const fm: SkillFrontmatter = { name, description };
  if (typeof data['license'] === 'string') fm.license = data['license'];
  if (typeof data['compatibility'] === 'string') fm.compatibility = data['compatibility'];
  if (typeof data['allowed-tools'] === 'string') fm['allowed-tools'] = data['allowed-tools'];
  if (data['metadata'] && typeof data['metadata'] === 'object' && !Array.isArray(data['metadata'])) {
    fm.metadata = data['metadata'] as Record<string, string>;
  }
  return fm;
}
