import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { WORKSPACE_SKILLS_DIR } from '../../services/workspace-skills.js';
import { makeReadSkillReferenceTool } from './read-skill-reference.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(opts: { workspaceId?: string; activeSkill?: string } = {}): any {
  return { configurable: opts, toolCallId: 'call-1' };
}

describe('agents/tools/read-skill-reference', () => {
  let dir: string;
  let store: WorkspaceStore;
  let global: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'read-skill-reference-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    const globalRoot = join(dir, 'global-skills');
    global = new SkillsManager(globalRoot);
    await global.boot();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a real reference file for the active skill [unit]', async () => {
    await global.create({ name: 'with-ref', description: 'x', body: 'y' });
    await global.writeFile('with-ref', 'references', 'operations.md', '# Ops\n\nSteps here.');
    const tool = makeReadSkillReferenceTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: 'operations.md' },
      invokeConfig({ activeSkill: 'with-ref' }),
    )) as unknown as string;

    expect(result).to.equal('# Ops\n\nSteps here.');
  });

  it('errors clearly when no skill is active [unit]', async () => {
    const tool = makeReadSkillReferenceTool({ globalManager: global, store });

    const result = (await tool.invoke({ name: 'operations.md' }, invokeConfig())) as unknown as string;

    expect(result).to.include('No skill is currently active');
  });

  it('rejects an unsafe file name without touching the filesystem [unit]', async () => {
    await global.create({ name: 'with-ref', description: 'x', body: 'y' });
    const tool = makeReadSkillReferenceTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: '../../etc/passwd' },
      invokeConfig({ activeSkill: 'with-ref' }),
    )) as unknown as string;

    expect(result).to.include('not a safe file name');
  });

  it('reports a clear error for a reference file that does not exist [unit]', async () => {
    await global.create({ name: 'with-ref', description: 'x', body: 'y' });
    const tool = makeReadSkillReferenceTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: 'missing.md' },
      invokeConfig({ activeSkill: 'with-ref' }),
    )) as unknown as string;

    expect(result).to.include('No reference file named');
  });

  it('errors when the active skill cannot be resolved at all [unit]', async () => {
    const tool = makeReadSkillReferenceTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: 'operations.md' },
      invokeConfig({ activeSkill: 'does-not-exist' }),
    )) as unknown as string;

    expect(result).to.include('could not be resolved');
  });

  it('asks the user to disambiguate for a cross-scope collision [unit]', async () => {
    await global.create({ name: 'shared', description: 'global', body: 'x' });
    const location = join(dir, 'ws');
    mkdirSync(location, { recursive: true });
    const workspace = store.createWorkspace({ name: 'ws', location, remoteUrl: null });
    mkdirSync(join(location, WORKSPACE_SKILLS_DIR, 'shared'), { recursive: true });
    writeFileSync(
      join(location, WORKSPACE_SKILLS_DIR, 'shared', 'SKILL.md'),
      '---\nname: shared\ndescription: workspace\n---\ny\n',
    );

    const tool = makeReadSkillReferenceTool({ globalManager: global, store });
    const result = (await tool.invoke(
      { name: 'operations.md' },
      invokeConfig({ activeSkill: 'shared', workspaceId: workspace.id }),
    )) as unknown as string;

    expect(result).to.include('exists both app-wide and in this workspace');
    expect(result).to.include('ask_user');
  });

  it('resolves a workspace-scoped skill reference [unit]', async () => {
    const location = join(dir, 'ws2');
    mkdirSync(location, { recursive: true });
    const workspace = store.createWorkspace({ name: 'ws2', location, remoteUrl: null });
    const workspaceManager = new SkillsManager(join(location, WORKSPACE_SKILLS_DIR));
    await workspaceManager.boot();
    await workspaceManager.create({ name: 'repo-skill', description: 'x', body: 'y' });
    await workspaceManager.writeFile('repo-skill', 'references', 'notes.md', 'repo notes');

    const tool = makeReadSkillReferenceTool({ globalManager: global, store });
    const result = (await tool.invoke(
      { name: 'notes.md' },
      invokeConfig({ activeSkill: 'repo-skill', workspaceId: workspace.id }),
    )) as unknown as string;

    expect(result).to.equal('repo notes');
  });
});
