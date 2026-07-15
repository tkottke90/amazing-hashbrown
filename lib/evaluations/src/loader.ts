import { parse } from 'yaml';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { SuiteSchema, type Suite } from './schemas.js';

export interface SuiteLoaderConfig {
  bundledPath: string;
  userPath?: string;
}

async function loadFromDir(dir: string, map: Map<string, Suite>): Promise<void> {
  if (!existsSync(dir)) return;

  const entries = await readdir(dir, { recursive: true });
  const yamlFiles = entries.filter((f) => extname(f) === '.yaml' || extname(f) === '.yml');

  for (const file of yamlFiles) {
    const filePath = join(dir, file);
    const raw = await readFile(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse YAML in ${filePath}: ${String(err)}`);
    }
    const result = SuiteSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid suite definition in ${filePath}:\n${result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
      );
    }
    map.set(result.data.suite.id, result.data);
  }
}

export async function loadSuites(config: SuiteLoaderConfig): Promise<Map<string, Suite>> {
  const map = new Map<string, Suite>();
  await loadFromDir(config.bundledPath, map);
  if (config.userPath) {
    await loadFromDir(config.userPath, map);
  }
  return map;
}

export async function loadSuite(id: string, config: SuiteLoaderConfig): Promise<Suite | null> {
  const map = await loadSuites(config);
  return map.get(id) ?? null;
}
