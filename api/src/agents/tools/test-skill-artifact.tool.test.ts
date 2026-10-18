import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { makeTestSkillArtifactTool } from './test-skill-artifact.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: {}, toolCallId: 'call-1' };
}

describe('agents/tools/test-skill-artifact', () => {
  let dir: string;
  let store: WorkspaceStore;
  let global: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'test-skill-artifact-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    global = new SkillsManager(join(dir, 'global-skills'));
    await global.boot();
    await global.create({ name: 'target-skill', description: 'Desc', body: 'Body.' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a Python script and reports real stdout/stderr/exitCode [unit]', async () => {
    await global.writeFile('target-skill', 'scripts', 'hello.py', 'print("hi from python")');
    const tool = makeTestSkillArtifactTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { skill: 'target-skill', name: 'hello.py' },
      invokeConfig(),
    )) as unknown as string;
    const payload = JSON.parse(result);

    expect(payload.stdout).to.include('hi from python');
    expect(payload.exitCode).to.equal(0);
  });

  it('runs a JS script and reports only its return value, not a stdout/stderr/exitCode triple [unit]', async () => {
    await global.writeFile('target-skill', 'scripts', 'hello.js', '42');
    const tool = makeTestSkillArtifactTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { skill: 'target-skill', name: 'hello.js' },
      invokeConfig(),
    )) as unknown as string;
    const payload = JSON.parse(result);

    expect(payload.result).to.equal(42);
    expect(payload.stdout).to.equal(undefined);
  });

  it('reports an unsupported extension as a plain string, not a throw [unit]', async () => {
    await global.writeFile('target-skill', 'scripts', 'hello.sh', 'echo hi');
    const tool = makeTestSkillArtifactTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { skill: 'target-skill', name: 'hello.sh' },
      invokeConfig(),
    )) as unknown as string;

    expect(result).to.include('not a script this tool can dry-run');
  });

  it('returns a not-found message for an unknown skill [unit]', async () => {
    const tool = makeTestSkillArtifactTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { skill: 'nope', name: 'hello.py' },
      invokeConfig(),
    )) as unknown as string;

    expect(result).to.include('No skill named');
  });
});
