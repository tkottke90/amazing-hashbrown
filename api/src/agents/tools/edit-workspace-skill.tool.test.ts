import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { WORKSPACE_SKILLS_DIR } from '../../services/workspace-skills.js';
import { makeEditWorkspaceSkillTool } from './edit-workspace-skill.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(workspaceId?: string): any {
  return { configurable: { workspaceId }, toolCallId: 'call-1' };
}

describe('agents/tools/edit-workspace-skill', () => {
  let dir: string;
  let store: WorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edit-workspace-skill-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeWorkspace(name: string) {
    const location = join(dir, name);
    mkdirSync(location, { recursive: true });
    return { location, workspace: store.createWorkspace({ name, location, remoteUrl: null }) };
  }

  it('edits the on-disk skill and returns a plain string [unit]', async () => {
    const { workspace, location } = makeWorkspace('ws-edit');
    const seedManager = new SkillsManager(join(location, WORKSPACE_SKILLS_DIR));
    await seedManager.boot();
    await seedManager.create({ name: 'local-helper', description: 'Old', body: 'Old body.' });

    const tool = makeEditWorkspaceSkillTool({ store });
    const result = await tool.invoke(
      { name: 'local-helper', description: 'New' },
      invokeConfig(workspace.id),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('not committed');

    const manager = new SkillsManager(join(location, WORKSPACE_SKILLS_DIR));
    await manager.boot();
    const skill = await manager.load('local-helper');
    expect(skill.frontmatter.description).to.equal('New');
  });

  it('refuses to run with no workspaceId in context [unit]', async () => {
    const tool = makeEditWorkspaceSkillTool({ store });

    const result = await tool.invoke({ name: 'x', description: 'y' }, invokeConfig(undefined));

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('workspace chat');
  });

  it('relays an unknown-name error as a plain string [unit]', async () => {
    const { workspace } = makeWorkspace('ws-unknown');
    const tool = makeEditWorkspaceSkillTool({ store });

    const result = await tool.invoke(
      { name: 'nope', description: 'x' },
      invokeConfig(workspace.id),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('not found');
  });
});
