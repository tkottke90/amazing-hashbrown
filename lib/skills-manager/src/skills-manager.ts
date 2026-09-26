import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serialize, validateFrontmatter, parse, DESCRIPTION_MAX } from './internal/frontmatter.js';
import { scanSkillsRoot, readFrontmatter, readFullSkill } from './internal/loader.js';
import {
  runJsScript,
  runPythonScript as execPythonScript,
  setRunnerExecutor,
} from './internal/runner.js';
import type { ShellExecutor } from '@tkottke90/shell-executor';
import type {
  Skill,
  SkillSummary,
  SkillFrontmatter,
  CreateSkillInput,
  EditSkillInput,
  ScriptResult,
  EvalSuite,
  BootResult,
  SkippedSkill,
} from './types.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const NAME_MAX = 64;
const SKILL_FILE = 'SKILL.md';

export interface ChildOptions {
  source: string; // label stamped on the child's summaries (e.g. 'repo')
  reserved?: string[]; // names the child may never serve; the parent's version always wins
}

export class SkillsManager {
  private readonly skillsRoot: string;
  private readonly cache: Map<string, SkillSummary> = new Map();
  private source = 'global';
  private parent: SkillsManager | null = null;
  private reserved: ReadonlySet<string> = new Set();

  constructor(skillsRoot: string) {
    this.skillsRoot = skillsRoot;
  }

  // Layers a read-only directory over this manager. Reads resolve the
  // child's own skills first and fall through to this manager; every write
  // and script-execution method on the child throws. The child is unbooted —
  // call boot() before use. Nothing is cached across calls to createChild, so
  // a fresh child always reflects the directory's current contents.
  createChild(skillsRoot: string, options: ChildOptions): SkillsManager {
    const child = new SkillsManager(skillsRoot);
    child.parent = this;
    child.source = options.source;
    child.reserved = new Set(options.reserved ?? []);
    return child;
  }

  setExecutor(executor: ShellExecutor): void {
    setRunnerExecutor(executor);
  }

  // Rebuilds the in-memory index from disk. Skills that can't be served are
  // left out and reported (never thrown) so one broken SKILL.md can't hide
  // the rest of the directory.
  async boot(): Promise<BootResult> {
    this.cache.clear();
    const skipped: SkippedSkill[] = [];
    const dirs = await scanSkillsRoot(this.skillsRoot);
    await Promise.all(
      dirs.map(async (dir) => {
        let summary;
        try {
          summary = await readFrontmatter(join(this.skillsRoot, dir));
        } catch (err) {
          skipped.push({
            dir,
            reason: 'invalid-frontmatter',
            detail: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        // Every path lookup is built from the skill name, so a name that
        // differs from its directory would list fine and then fail on use.
        if (summary.name !== dir) {
          skipped.push({ dir, reason: 'name-mismatch' });
          return;
        }
        if (this.reserved.has(summary.name)) {
          skipped.push({ dir, reason: 'reserved' });
          return;
        }
        // A disabled child skill is treated as absent so the parent's
        // same-named skill shows through.
        if (this.parent && !summary.enabled) return;
        this.cache.set(summary.name, { ...summary, source: this.source });
      }),
    );
    skipped.sort((a, b) => a.dir.localeCompare(b.dir));
    return { skipped };
  }

  list(): SkillSummary[] {
    const own = Array.from(this.cache.values());
    if (!this.parent) return own;
    const inherited = this.parent.list();
    const parentNames = new Set(inherited.map((s) => s.name));
    return [
      ...inherited.filter((s) => !this.cache.has(s.name)),
      ...own.map((s) => (parentNames.has(s.name) ? { ...s, overrides: true } : s)),
    ];
  }

  search(keyword?: string): SkillSummary[] {
    const all = this.list().filter((s) => s.enabled);
    if (!keyword) return all;
    const q = keyword.toLowerCase();
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.slashCommand.toLowerCase().includes(q),
    );
  }

  async lookup(name: string): Promise<string> {
    const owner = this.owner(name);
    if (owner !== this) return owner.lookup(name);
    const raw = await readFile(join(this.skillsRoot, name, SKILL_FILE), 'utf8');
    const { body } = parse(raw);
    return body;
  }

  async load(name: string): Promise<Skill> {
    const owner = this.owner(name);
    if (owner !== this) return owner.load(name);
    return readFullSkill(join(this.skillsRoot, name));
  }

  async create(input: CreateSkillInput): Promise<Skill> {
    this.assertWritable();
    const { name, description, body, license, compatibility, metadata, allowedTools } = input;
    if (!name || name.length > NAME_MAX || !NAME_RE.test(name)) {
      throw new Error(
        `Invalid skill name "${name}": must match /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ and be ≤${NAME_MAX} chars`,
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
      largeDesc: skill.frontmatter.description.length > DESCRIPTION_MAX,
      source: this.source,
    });
    return skill;
  }

  async edit(name: string, changes: EditSkillInput): Promise<Skill> {
    this.assertWritable();
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
      largeDesc: skill.frontmatter.description.length > DESCRIPTION_MAX,
      source: this.source,
    });
    return skill;
  }

  async delete(name: string): Promise<void> {
    this.assertWritable();
    this.assertExists(name);
    await rm(join(this.skillsRoot, name), { recursive: true, force: true });
    this.cache.delete(name);
  }

  async runScript(
    name: string,
    scriptFile: string,
    context?: Record<string, unknown>,
  ): Promise<unknown> {
    this.assertWritable();
    this.assertExists(name);
    const scriptPath = join(this.skillsRoot, name, 'scripts', scriptFile);
    return runJsScript(scriptPath, context);
  }

  async runPythonScript(name: string, scriptFile: string, args?: string[]): Promise<ScriptResult> {
    this.assertWritable();
    this.assertExists(name);
    const skillPath = join(this.skillsRoot, name);
    const scriptPath = join(skillPath, 'scripts', scriptFile);
    return execPythonScript(skillPath, scriptPath, args);
  }

  async readFile(
    name: string,
    dir: 'scripts' | 'references' | 'evals',
    basename: string,
  ): Promise<string> {
    const owner = this.owner(name);
    if (owner !== this) return owner.readFile(name, dir, basename);
    return readFile(join(this.skillsRoot, name, dir, basename), 'utf8');
  }

  async writeFile(
    name: string,
    dir: 'scripts' | 'references' | 'evals',
    basename: string,
    content: string,
  ): Promise<void> {
    this.assertWritable();
    this.assertExists(name);
    const dirPath = join(this.skillsRoot, name, dir);
    await mkdir(dirPath, { recursive: true });
    await writeFile(join(dirPath, basename), content, 'utf8');
  }

  async deleteFile(
    name: string,
    dir: 'scripts' | 'references' | 'evals',
    basename: string,
  ): Promise<void> {
    this.assertWritable();
    this.assertExists(name);
    await rm(join(this.skillsRoot, name, dir, basename));
  }

  async loadEvals(name: string): Promise<EvalSuite> {
    const owner = this.owner(name);
    if (owner !== this) return owner.loadEvals(name);
    const evalsPath = join(this.skillsRoot, name, 'evals', 'evals.json');
    let raw: string;
    try {
      raw = await readFile(evalsPath, 'utf8');
    } catch {
      throw new Error(`No evals found for skill "${name}" — create evals/evals.json first`);
    }
    return JSON.parse(raw) as EvalSuite;
  }

  async saveEvals(name: string, suite: EvalSuite): Promise<void> {
    this.assertWritable();
    this.assertExists(name);
    const evalsDir = join(this.skillsRoot, name, 'evals');
    await mkdir(evalsDir, { recursive: true });
    await writeFile(join(evalsDir, 'evals.json'), JSON.stringify(suite, null, 2), 'utf8');
  }

  private assertExists(name: string): void {
    if (!this.cache.has(name)) {
      throw new Error(`Skill "${name}" not found`);
    }
  }

  // The manager whose directory holds `name`: this one first, then up the
  // parent chain. Throws the usual not-found error when no manager has it.
  private owner(name: string): SkillsManager {
    if (this.cache.has(name)) return this;
    if (this.parent) return this.parent.owner(name);
    throw new Error(`Skill "${name}" not found`);
  }

  // Child managers serve someone else's directory (e.g. a cloned repo): they
  // never write to it, never write through to the parent, and never execute
  // scripts. Called as the first statement of every such method so no path is
  // built and the runner is never reached.
  private assertWritable(): void {
    if (this.parent) {
      throw new Error(`Skill manager for ${this.skillsRoot} is read-only`);
    }
  }
}
