import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { WORKSPACE_SKILLS_DIR } from '../../services/workspace-skills.js';
import { makeCreateWorkspaceSkillTool } from './create-workspace-skill.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(workspaceId?: string): any {
  return { configurable: { workspaceId }, toolCallId: 'call-1' };
}

describe('agents/tools/create-workspace-skill', () => {
  let dir: string;
  let store: WorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'create-workspace-skill-tool-test-'));
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

  it("writes the skill under the workspace's .agents/skills and returns a plain string [unit]", async () => {
    const { workspace, location } = makeWorkspace('ws-one');
    const tool = makeCreateWorkspaceSkillTool({ store });

    const result = await tool.invoke(
      { name: 'local-helper', description: 'Helps with local stuff', body: 'Body text.' },
      invokeConfig(workspace.id),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('not committed');

    const manager = new SkillsManager(join(location, WORKSPACE_SKILLS_DIR));
    await manager.boot();
    const skill = await manager.load('local-helper');
    expect(skill.frontmatter.description).to.equal('Helps with local stuff');
  });

  it('refuses to run with no workspaceId in context [unit]', async () => {
    const tool = makeCreateWorkspaceSkillTool({ store });

    const result = await tool.invoke(
      { name: 'x', description: 'y', body: 'z' },
      invokeConfig(undefined),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('create_app_skill');
  });

  it('relays a duplicate-name conflict as a plain string [unit]', async () => {
    const { workspace } = makeWorkspace('ws-two');
    const tool = makeCreateWorkspaceSkillTool({ store });

    await tool.invoke({ name: 'dup', description: 'first', body: 'x' }, invokeConfig(workspace.id));
    const result = await tool.invoke(
      { name: 'dup', description: 'second', body: 'y' },
      invokeConfig(workspace.id),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('already exists');
  });
});
