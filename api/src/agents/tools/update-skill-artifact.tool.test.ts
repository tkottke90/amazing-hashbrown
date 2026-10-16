import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { makeUpdateSkillArtifactTool } from './update-skill-artifact.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: {}, toolCallId: 'call-1' };
}

describe('agents/tools/update-skill-artifact', () => {
  let dir: string;
  let store: WorkspaceStore;
  let global: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'update-skill-artifact-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    global = new SkillsManager(join(dir, 'global-skills'));
    await global.boot();
    await global.create({ name: 'target-skill', description: 'Desc', body: 'Body.' });
    await global.writeFile('target-skill', 'scripts', 'run.py', 'print("v1")');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites an existing artifact with no existence check [unit]', async () => {
    const tool = makeUpdateSkillArtifactTool({ globalManager: global, store });

    const result = await tool.invoke(
      { skill: 'target-skill', type: 'script', name: 'run.py', content: 'print("v2")' },
      invokeConfig(),
    );

    expect(result as unknown as string).to.include('Updated');
    const content = await global.readFile('target-skill', 'scripts', 'run.py');
    expect(content).to.equal('print("v2")');
  });

  it('writes a brand-new file too (plain overwrite semantics) [unit]', async () => {
    const tool = makeUpdateSkillArtifactTool({ globalManager: global, store });

    const result = await tool.invoke(
      { skill: 'target-skill', type: 'reference', name: 'new.md', content: 'fresh' },
      invokeConfig(),
    );

    expect(result as unknown as string).to.include('Updated');
    const content = await global.readFile('target-skill', 'references', 'new.md');
    expect(content).to.equal('fresh');
  });

  it('rejects a path-traversal basename [unit]', async () => {
    const tool = makeUpdateSkillArtifactTool({ globalManager: global, store });

    const result = await tool.invoke(
      { skill: 'target-skill', type: 'script', name: '..', content: 'x' },
      invokeConfig(),
    );

    expect(result as unknown as string).to.include('not a safe file name');
  });
});
