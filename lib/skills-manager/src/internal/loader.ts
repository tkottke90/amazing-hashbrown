import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, validateFrontmatter } from './frontmatter.js';
import type { Skill, SkillSummary } from '../types.js';

const SKILL_FILE = 'SKILL.md';

export async function scanSkillsRoot(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    try {
      await readFile(join(root, entry, SKILL_FILE));
      names.push(entry);
    } catch {
      // not a skill directory — skip
    }
  }
  return names;
}

export async function readFrontmatter(skillPath: string): Promise<SkillSummary> {
  const raw = await readFile(join(skillPath, SKILL_FILE), 'utf8');
  const { data } = parse(raw);
  const fm = validateFrontmatter(data);
  return {
    name: fm.name,
    description: fm.description,
    slashCommand: `/${fm.name}`,
    enabled: fm.metadata?.['enabled'] !== 'false',
  };
}

async function inventoryDir(dir: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      map[entry] = join(dir, entry);
    }
  } catch {
    // directory absent — return empty map
  }
  return map;
}

export async function readFullSkill(skillPath: string): Promise<Skill> {
  const raw = await readFile(join(skillPath, SKILL_FILE), 'utf8');
  const { data, body } = parse(raw);
  const fm = validateFrontmatter(data);

  const scripts = await inventoryDir(join(skillPath, 'scripts'));
  const references = await inventoryDir(join(skillPath, 'references'));

  return {
    name: fm.name,
    slashCommand: `/${fm.name}`,
    enabled: fm.metadata?.['enabled'] !== 'false',
    path: skillPath,
    frontmatter: fm,
    body,
    scripts,
    references,
  };
}
