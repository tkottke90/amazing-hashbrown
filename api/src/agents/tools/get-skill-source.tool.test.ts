import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { WORKSPACE_SKILLS_DIR } from '../../services/workspace-skills.js';
import { makeGetSkillSourceTool } from './get-skill-source.tool.js';

function writeRawSkill(root: string, name: string, frontmatterBody: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), frontmatterBody, 'utf8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(workspaceId?: string): any {
  return { configurable: { workspaceId }, toolCallId: 'call-1' };
}

describe('agents/tools/get-skill-source', () => {
  let dir: string;
  let store: WorkspaceStore;
  let global: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'get-skill-source-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    const globalRoot = join(dir, 'global-skills');
    global = new SkillsManager(globalRoot);
    await global.boot();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns frontmatter/body for a healthy app-scope skill [unit]', async () => {
    await global.create({ name: 'healthy', description: 'Desc', body: 'Body text.' });
    const tool = makeGetSkillSourceTool({ globalManager: global, store });

    const result = (await tool.invoke({ name: 'healthy' }, invokeConfig())) as unknown as string;
    const payload = JSON.parse(result);

    expect(payload.scope).to.equal('app');
    expect(payload.exists).to.equal(true);
    expect(payload.issue).to.equal(undefined);
    expect(payload.frontmatter.description).to.equal('Desc');
  });

  it('reaches a skill broken enough to fail boot() validation, reporting issue not throwing [unit]', async () => {
    const globalRoot = join(dir, 'global-skills');
    writeRawSkill(globalRoot, 'broken', '---\ndescription: missing a name field\n---\nBody\n');
    await global.boot();
    const tool = makeGetSkillSourceTool({ globalManager: global, store });

    const result = (await tool.invoke({ name: 'broken' }, invokeConfig())) as unknown as string;
    const payload = JSON.parse(result);

    expect(payload.exists).to.equal(true);
    expect(payload.issue).to.match(/missing required field: name/);
  });

  it('returns a not-found message for a name in neither scope [unit]', async () => {
    const tool = makeGetSkillSourceTool({ globalManager: global, store });

    const result = (await tool.invoke({ name: 'nowhere' }, invokeConfig())) as unknown as string;

    expect(result).to.include('No skill named');
  });

  it('returns a disambiguation message, not a silent pick, for a cross-scope collision [unit]', async () => {
    await global.create({ name: 'shared', description: 'global', body: 'x' });
    const location = join(dir, 'ws');
    mkdirSync(location, { recursive: true });
    const workspace = store.createWorkspace({ name: 'ws', location, remoteUrl: null });
    writeRawSkill(
      join(location, WORKSPACE_SKILLS_DIR),
      'shared',
      '---\nname: shared\ndescription: workspace\n---\ny\n',
    );

    const tool = makeGetSkillSourceTool({ globalManager: global, store });
    const result = (await tool.invoke(
      { name: 'shared' },
      invokeConfig(workspace.id),
    )) as unknown as string;

    expect(result).to.include('exists both app-wide and in this workspace');
    expect(result).to.include('ask_user');
  });
});
