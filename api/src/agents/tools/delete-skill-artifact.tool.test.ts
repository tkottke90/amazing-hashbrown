import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { makeDeleteSkillArtifactTool } from './delete-skill-artifact.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: {}, toolCallId: 'call-1' };
}

describe('agents/tools/delete-skill-artifact', () => {
  let dir: string;
  let store: WorkspaceStore;
  let global: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'delete-skill-artifact-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    global = new SkillsManager(join(dir, 'global-skills'));
    await global.boot();
    await global.create({ name: 'target-skill', description: 'Desc', body: 'Body.' });
    await global.writeFile('target-skill', 'scripts', 'run.py', 'print("hi")');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes an existing artifact [unit]', async () => {
    const tool = makeDeleteSkillArtifactTool({ globalManager: global, store });

    const result = await tool.invoke(
      { skill: 'target-skill', type: 'script', name: 'run.py' },
      invokeConfig(),
    );

    expect(result as unknown as string).to.include('Removed');
    let threw = false;
    try {
      await global.readFile('target-skill', 'scripts', 'run.py');
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('returns a clean message, not an ENOENT throw, for an already-missing file [unit]', async () => {
    const tool = makeDeleteSkillArtifactTool({ globalManager: global, store });

    const result = await tool.invoke(
      { skill: 'target-skill', type: 'script', name: 'does-not-exist.py' },
      invokeConfig(),
    );

    expect(result as unknown as string).to.include('nothing to remove');
  });
});
