import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serialize, validateFrontmatter, parse } from './internal/frontmatter.js';
import { scanSkillsRoot, readFrontmatter, readFullSkill } from './internal/loader.js';
import { runJsScript, runPythonScript as execPythonScript } from './internal/runner.js';
import type {
  Skill,
  SkillSummary,
  SkillFrontmatter,
  CreateSkillInput,
  EditSkillInput,
  ScriptResult,
} from './types.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const NAME_MAX = 64;
const SKILL_FILE = 'SKILL.md';

export class SkillsManager {
  private readonly skillsRoot: string;
  private readonly cache: Map<string, SkillSummary> = new Map();

  constructor(skillsRoot: string) {
    this.skillsRoot = skillsRoot;
  }

  async boot(): Promise<void> {
    this.cache.clear();
    const names = await scanSkillsRoot(this.skillsRoot);
    await Promise.all(
      names.map(async (name) => {
        try {
          const summary = await readFrontmatter(join(this.skillsRoot, name));
          this.cache.set(summary.name, summary);
        } catch {
          // malformed skill — skip silently on boot
        }
      })
    );
  }

  list(): SkillSummary[] {
    return Array.from(this.cache.values());
  }

  async lookup(name: string): Promise<string> {
    this.assertExists(name);
    const raw = await readFile(join(this.skillsRoot, name, SKILL_FILE), 'utf8');
    const { body } = parse(raw);
    return body;
  }

  async load(name: string): Promise<Skill> {
    this.assertExists(name);
    return readFullSkill(join(this.skillsRoot, name));
  }

  async create(input: CreateSkillInput): Promise<Skill> {
    const { name, description, body, license, compatibility, metadata, allowedTools } = input;
    if (!name || name.length > NAME_MAX || !NAME_RE.test(name)) {
      throw new Error(
        `Invalid skill name "${name}": must match /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ and be ≤${NAME_MAX} chars`
      );
    }
    if (this.cache.has(name)) {
      throw new Error(`Skill "${name}" already exists`);
    }

    const skillPath = join(this.skillsRoot, name);
    await mkdir(skillPath, { recursive: true });

    const fm: SkillFrontmatter = { name, description };
    if (license) fm.license = license;
    if (compatibility) fm.compatibility = compatibility;
    if (allowedTools) fm['allowed-tools'] = allowedTools;
    if (metadata) fm.metadata = metadata;

    const content = serialize(fm, body);
    await writeFile(join(skillPath, SKILL_FILE), content, 'utf8');

    const skill = await readFullSkill(skillPath);
    this.cache.set(name, {
      name: skill.name,
      description: skill.frontmatter.description,
      slashCommand: skill.slashCommand,
      enabled: skill.enabled,
    });
    return skill;
  }

  async edit(name: string, changes: EditSkillInput): Promise<Skill> {
    this.assertExists(name);
    const skillPath = join(this.skillsRoot, name);
    const skillFilePath = join(skillPath, SKILL_FILE);
    const tmpPath = join(skillPath, `${SKILL_FILE}.tmp`);

    const raw = await readFile(skillFilePath, 'utf8');
    const { data, body: existingBody } = parse(raw);
    const fm = validateFrontmatter(data);

    if (changes.description !== undefined) fm.description = changes.description;
    if (changes.license !== undefined) fm.license = changes.license;
    if (changes.compatibility !== undefined) fm.compatibility = changes.compatibility;
    if (changes.allowedTools !== undefined) fm['allowed-tools'] = changes.allowedTools;
    if (changes.metadata !== undefined) fm.metadata = changes.metadata;
    if (changes.enabled !== undefined) {
      fm.metadata = { ...(fm.metadata ?? {}), enabled: changes.enabled ? 'true' : 'false' };
    }

    const newBody = changes.body !== undefined ? changes.body : existingBody;
    const content = serialize(fm, newBody);

    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, skillFilePath);

    const skill = await readFullSkill(skillPath);
    this.cache.set(name, {
      name: skill.name,
      description: skill.frontmatter.description,
      slashCommand: skill.slashCommand,
      enabled: skill.enabled,
    });
    return skill;
  }

  async delete(name: string): Promise<void> {
    this.assertExists(name);
    await rm(join(this.skillsRoot, name), { recursive: true, force: true });
    this.cache.delete(name);
  }

  async runScript(
    name: string,
    scriptFile: string,
    context?: Record<string, unknown>
  ): Promise<unknown> {
    this.assertExists(name);
    const scriptPath = join(this.skillsRoot, name, 'scripts', scriptFile);
    return runJsScript(scriptPath, context);
  }

  async runPythonScript(
    name: string,
    scriptFile: string,
    args?: string[]
  ): Promise<ScriptResult> {
    this.assertExists(name);
    const skillPath = join(this.skillsRoot, name);
    const scriptPath = join(skillPath, 'scripts', scriptFile);
    return execPythonScript(skillPath, scriptPath, args);
  }

  async readFile(
    name: string,
    dir: 'scripts' | 'references',
    basename: string
  ): Promise<string> {
    this.assertExists(name);
    return readFile(join(this.skillsRoot, name, dir, basename), 'utf8');
  }

  async writeFile(
    name: string,
    dir: 'scripts' | 'references',
    basename: string,
    content: string
  ): Promise<void> {
    this.assertExists(name);
    const dirPath = join(this.skillsRoot, name, dir);
    await mkdir(dirPath, { recursive: true });
    await writeFile(join(dirPath, basename), content, 'utf8');
  }

  async deleteFile(
    name: string,
    dir: 'scripts' | 'references',
    basename: string
  ): Promise<void> {
    this.assertExists(name);
    await rm(join(this.skillsRoot, name, dir, basename));
  }

  private assertExists(name: string): void {
    if (!this.cache.has(name)) {
      throw new Error(`Skill "${name}" not found`);
    }
  }
}
