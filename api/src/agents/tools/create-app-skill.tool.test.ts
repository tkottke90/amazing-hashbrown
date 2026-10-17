import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { SkillsManager } from '@tkottke90/skills-manager';
import { makeCreateAppSkillTool } from './create-app-skill.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: {}, toolCallId: 'call-1' };
}

describe('agents/tools/create-app-skill', () => {
  let root: string;
  let manager: SkillsManager;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'create-app-skill-tool-test-'));
    manager = new SkillsManager(root);
    await manager.boot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a skill on disk and returns a plain string (no Command/gate change) [unit]', async () => {
    const tool = makeCreateAppSkillTool(manager);

    const result = await tool.invoke(
      { name: 'wiki-tips', description: 'Tips for searching the wiki', body: 'Body text.' },
      invokeConfig(),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('wiki-tips');
    const skill = await manager.load('wiki-tips');
    expect(skill.frontmatter.description).to.equal('Tips for searching the wiki');
  });

  it('relays a duplicate-name conflict as a plain string, not a throw [unit]', async () => {
    const tool = makeCreateAppSkillTool(manager);
    await tool.invoke({ name: 'dup-skill', description: 'First', body: 'x' }, invokeConfig());

    const result = await tool.invoke(
      { name: 'dup-skill', description: 'Second', body: 'y' },
      invokeConfig(),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('already exists');
    expect(manager.list()).to.have.length(1);
  });

  it('relays an invalid-name error as a plain string [unit]', async () => {
    const tool = makeCreateAppSkillTool(manager);

    const result = await tool.invoke(
      { name: 'Not Valid', description: 'desc', body: 'x' },
      invokeConfig(),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('Invalid skill name');
    expect(manager.list()).to.have.length(0);
  });
});
