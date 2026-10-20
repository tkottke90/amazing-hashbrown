import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { makeRunSkillScriptTool } from './run-skill-script.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(opts: { workspaceId?: string; activeSkill?: string } = {}): any {
  return { configurable: opts, toolCallId: 'call-1' };
}

describe('agents/tools/run-skill-script', () => {
  let dir: string;
  let store: WorkspaceStore;
  let global: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'run-skill-script-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    const globalRoot = join(dir, 'global-skills');
    global = new SkillsManager(globalRoot);
    await global.boot();
    await global.create({ name: 'with-script', description: 'x', body: 'y' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a .py script for the active skill and returns a uniform ScriptResult [unit]', async () => {
    await global.writeFile('with-script', 'scripts', 'check.py', 'print("py ok")');
    const tool = makeRunSkillScriptTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: 'check.py' },
      invokeConfig({ activeSkill: 'with-script' }),
    )) as unknown as string;
    const payload = JSON.parse(result);

    expect(payload.stdout.trim()).to.equal('py ok');
    expect(payload.exitCode).to.equal(0);
  });

  it('runs a .sh script for the active skill [unit]', async () => {
    await global.writeFile('with-script', 'scripts', 'check.sh', 'echo "sh ok"');
    const tool = makeRunSkillScriptTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: 'check.sh' },
      invokeConfig({ activeSkill: 'with-script' }),
    )) as unknown as string;
    const payload = JSON.parse(result);

    expect(payload.stdout.trim()).to.equal('sh ok');
    expect(payload.exitCode).to.equal(0);
  });

  it('runs a .js script for the active skill, now with real stdout capture [unit]', async () => {
    await global.writeFile('with-script', 'scripts', 'check.js', 'console.log("js ok")');
    const tool = makeRunSkillScriptTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: 'check.js' },
      invokeConfig({ activeSkill: 'with-script' }),
    )) as unknown as string;
    const payload = JSON.parse(result);

    expect(payload.stdout.trim()).to.equal('js ok');
    expect(payload.exitCode).to.equal(0);
  });

  it('passes args through to the script [unit]', async () => {
    await global.writeFile('with-script', 'scripts', 'args.sh', 'echo "$1,$2"');
    const tool = makeRunSkillScriptTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: 'args.sh', args: ['a', 'b'] },
      invokeConfig({ activeSkill: 'with-script' }),
    )) as unknown as string;
    const payload = JSON.parse(result);

    expect(payload.stdout.trim()).to.equal('a,b');
  });

  it('errors clearly when no skill is active [unit]', async () => {
    const tool = makeRunSkillScriptTool({ globalManager: global, store });

    const result = (await tool.invoke({ name: 'check.py' }, invokeConfig())) as unknown as string;

    expect(result).to.include('No skill is currently active');
  });

  it('rejects an unsafe file name [unit]', async () => {
    const tool = makeRunSkillScriptTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: '../../etc/passwd' },
      invokeConfig({ activeSkill: 'with-script' }),
    )) as unknown as string;

    expect(result).to.include('not a safe file name');
  });

  it('reports unsupported extensions plainly [unit]', async () => {
    await global.writeFile('with-script', 'scripts', 'check.rb', 'puts "hi"');
    const tool = makeRunSkillScriptTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: 'check.rb' },
      invokeConfig({ activeSkill: 'with-script' }),
    )) as unknown as string;

    expect(result).to.include('not a script this tool can run');
  });

  it('errors when the active skill cannot be resolved at all [unit]', async () => {
    const tool = makeRunSkillScriptTool({ globalManager: global, store });

    const result = (await tool.invoke(
      { name: 'check.py' },
      invokeConfig({ activeSkill: 'does-not-exist' }),
    )) as unknown as string;

    expect(result).to.include('could not be resolved');
  });

  it('asks the user to disambiguate for a cross-scope collision [unit]', async () => {
    const location = join(dir, 'ws');
    mkdirSync(location, { recursive: true });
    const workspace = store.createWorkspace({ name: 'ws', location, remoteUrl: null });
    const workspaceManager = new SkillsManager(join(location, '.agents', 'skills'));
    await workspaceManager.boot();
    await workspaceManager.create({ name: 'with-script', description: 'repo', body: 'x' });

    const tool = makeRunSkillScriptTool({ globalManager: global, store });
    const result = (await tool.invoke(
      { name: 'check.py' },
      invokeConfig({ activeSkill: 'with-script', workspaceId: workspace.id }),
    )) as unknown as string;

    expect(result).to.include('exists both app-wide and in this workspace');
    expect(result).to.include('ask_user');
  });
});
