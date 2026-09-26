import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SkillFixture {
  name?: string; // frontmatter name; omit to write a SKILL.md with no name field
  description?: string;
  body?: string;
  enabled?: boolean;
}

// Writes <root>/<dir>/SKILL.md by hand (not via SkillsManager.create) so tests
// can produce skills create() would refuse: mismatched names, missing fields,
// or skills inside a directory a read-only child manager scans.
export async function writeSkill(root: string, dir: string, fx: SkillFixture = {}): Promise<void> {
  const lines = ['---'];
  if (fx.name !== undefined) lines.push(`name: ${fx.name}`);
  if (fx.description !== undefined) lines.push(`description: ${fx.description}`);
  if (fx.enabled === false) lines.push('metadata:', "  enabled: 'false'");
  lines.push('---', fx.body ?? `Body of ${dir}`);
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, 'SKILL.md'), lines.join('\n') + '\n', 'utf8');
}

export async function writeValidSkill(root: string, name: string, body?: string): Promise<void> {
  await writeSkill(root, name, { name, description: `Description of ${name}`, body });
}

// Recursive listing of every path under root, used to prove an operation left
// the filesystem untouched.
export async function snapshot(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries.map(String).sort();
}
