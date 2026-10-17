import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { makeCreateSkillArtifactTool } from './create-skill-artifact.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: {}, toolCallId: 'call-1' };
}

describe('agents/tools/create-skill-artifact', () => {
  let dir: string;
  let store: WorkspaceStore;
  let global: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'create-skill-artifact-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    global = new SkillsManager(join(dir, 'global-skills'));
    await global.boot();
    await global.create({ name: 'target-skill', description: 'Desc', body: 'Body.' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a new script artifact [unit]', async () => {
    const tool = makeCreateSkillArtifactTool({ globalManager: global, store });

    const result = await tool.invoke(
      { skill: 'target-skill', type: 'script', name: 'run.py', content: 'print("hi")' },
      invokeConfig(),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('Added');
    const content = await global.readFile('target-skill', 'scripts', 'run.py');
    expect(content).to.equal('print("hi")');
  });

  it('refuses to overwrite an existing artifact [unit]', async () => {
    const tool = makeCreateSkillArtifactTool({ globalManager: global, store });
    await tool.invoke(
      { skill: 'target-skill', type: 'reference', name: 'notes.md', content: 'v1' },
      invokeConfig(),
    );

    const result = await tool.invoke(
      { skill: 'target-skill', type: 'reference', name: 'notes.md', content: 'v2' },
      invokeConfig(),
    );

    expect(result as unknown as string).to.include('already exists');
    const content = await global.readFile('target-skill', 'references', 'notes.md');
    expect(content).to.equal('v1');
  });

  it('rejects a path-traversal basename without touching disk [unit]', async () => {
    const tool = makeCreateSkillArtifactTool({ globalManager: global, store });

    const result = await tool.invoke(
      { skill: 'target-skill', type: 'script', name: '../../etc/passwd', content: 'x' },
      invokeConfig(),
    );

    expect(result as unknown as string).to.include('not a safe file name');
  });

  it('returns a not-found message for an unknown skill [unit]', async () => {
    const tool = makeCreateSkillArtifactTool({ globalManager: global, store });

    const result = await tool.invoke(
      { skill: 'nope', type: 'script', name: 'run.py', content: 'x' },
      invokeConfig(),
    );

    expect(result as unknown as string).to.include('No skill named');
  });
});
