import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { SkillsManager } from '@tkottke90/skills-manager';
import { makeSearchSkillsTool } from './search-skills.tool.js';

function writeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\nbody\n`,
  );
}

// search_skills is how the agent discovers skills on its own; in a workspace
// it must see that workspace's repo skills alongside the global ones.
describe('agents/tools/search-skills.tool', () => {
  let dir: string;
  let global: SkillsManager;
  let child: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'search-skills-tool-test-'));
    writeSkill(join(dir, 'global'), 'global-skill');
    writeSkill(join(dir, 'repo'), 'repo-skill');
    global = new SkillsManager(join(dir, 'global'));
    await global.boot();
    child = global.createChild(join(dir, 'repo'), { source: 'repo' });
    await child.boot();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists global and repo skills together for a workspace source [unit]', async () => {
    const tool = makeSearchSkillsTool(async () => child);
    const result = JSON.parse(String(await tool.invoke({}))) as Array<{ name: string }>;
    expect(result.map((s) => s.name)).to.have.members(['global-skill', 'repo-skill']);
  });

  // The model-facing shape must not change with the source: exposing
  // source/overrides would alter what the LLM sees for no benefit.
  it('returns only name, slashCommand and description for each skill [unit]', async () => {
    const tool = makeSearchSkillsTool(async () => child);
    const result = JSON.parse(String(await tool.invoke({ keyword: 'repo-skill' })));
    expect(result).to.deep.equal([
      { name: 'repo-skill', slashCommand: '/repo-skill', description: 'repo-skill description' },
    ]);
  });

  it('reports no matches for an unknown keyword [unit]', async () => {
    const tool = makeSearchSkillsTool(async () => child);
    expect(await tool.invoke({ keyword: 'zzz' })).to.equal('No skills found matching "zzz".');
  });

  it('resolves the source on every call, not once at build time [unit]', async () => {
    let current: SkillsManager = global;
    const tool = makeSearchSkillsTool(async () => current);
    expect(String(await tool.invoke({}))).to.not.include('repo-skill');
    current = child;
    expect(String(await tool.invoke({}))).to.include('repo-skill');
  });
});
