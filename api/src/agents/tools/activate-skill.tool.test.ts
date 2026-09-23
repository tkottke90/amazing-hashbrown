import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { SkillsManager } from '@tkottke90/skills-manager';
import { makeActivateSkillTool } from './activate-skill.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: { thread_id: 'test-thread' }, toolCallId: 'call-1' };
}

describe('agents/tools/activate-skill', () => {
  let manager: SkillsManager;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'activate-skill-tool-test-'));
    manager = new SkillsManager(dir);
    await manager.boot();
    await manager.create({
      name: 'file-ops',
      description: 'Find, read, and edit workspace files.',
      body: 'Call find_file/read_file/edit_file as needed.',
      metadata: { selfCallable: 'true' },
    });
    await manager.create({
      name: 'create-workspace',
      description: 'Create a workspace conversationally.',
      body: 'Collect the workspace fields, then call create_workspace.',
      // No selfCallable metadata — gated, but not self-callable.
    });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the gate and injects the skill body for a self-callable skill', async () => {
    const tool = makeActivateSkillTool(manager);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await tool.invoke({ name: 'file-ops' }, invokeConfig())) as any;

    expect(result.update.activeGatedSkill).to.equal('file-ops');
    expect(result.update.messages[0].content).to.include('find_file/read_file/edit_file');
  });

  it('refuses a gated-but-not-self-callable skill and lists valid alternatives', async () => {
    const tool = makeActivateSkillTool(manager);

    const result = await tool.invoke({ name: 'create-workspace' }, invokeConfig());

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('not a self-callable skill');
    expect(result as unknown as string).to.include('file-ops');
  });

  it('refuses an unknown skill name and lists valid alternatives', async () => {
    const tool = makeActivateSkillTool(manager);

    const result = await tool.invoke({ name: 'does-not-exist' }, invokeConfig());

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('file-ops');
  });
});
