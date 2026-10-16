import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { SkillsManager } from '@tkottke90/skills-manager';
import { makeEditAppSkillTool } from './edit-app-skill.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: {}, toolCallId: 'call-1' };
}

describe('agents/tools/edit-app-skill', () => {
  let root: string;
  let manager: SkillsManager;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'edit-app-skill-tool-test-'));
    manager = new SkillsManager(root);
    await manager.boot();
    await manager.create({
      name: 'existing-skill',
      description: 'Old description',
      body: 'Old body.',
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('updates the skill and returns a plain string (no Command/gate change) [unit]', async () => {
    const tool = makeEditAppSkillTool(manager);

    const result = await tool.invoke(
      { name: 'existing-skill', description: 'New description' },
      invokeConfig(),
    );

    expect(result).to.be.a('string');
    const skill = await manager.load('existing-skill');
    expect(skill.frontmatter.description).to.equal('New description');
    expect(skill.body.trim()).to.equal('Old body.');
  });

  it('relays an unknown-name error as a plain string, not a throw [unit]', async () => {
    const tool = makeEditAppSkillTool(manager);

    const result = await tool.invoke({ name: 'nope', description: 'x' }, invokeConfig());

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('not found');
  });
});
