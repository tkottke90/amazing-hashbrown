import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from './workspace-store.js';
import { resolveWorkspaceSkills } from './workspace-skills.js';

function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`,
  );
}

// resolveWorkspaceSkills is the one place that decides which skills a
// workspace sees: the global set, plus whatever the workspace directory ships
// under .agents/skills — regardless of whether the workspace has a git remote.
describe('services/workspace-skills — resolveWorkspaceSkills', () => {
  let dir: string;
  let store: WorkspaceStore;
  let global: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-skills-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    const globalRoot = join(dir, 'global-skills');
    writeSkill(globalRoot, 'global-skill', 'global body');
    writeSkill(globalRoot, 'create-project', 'global gated body');
    global = new SkillsManager(globalRoot);
    await global.boot();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeWorkspace(name: string, remoteUrl: string | null = null) {
    const location = join(dir, name);
    mkdirSync(location, { recursive: true });
    return { location, workspace: store.createWorkspace({ name, location, remoteUrl }) };
  }

  it('returns null for an unknown workspace id [unit]', async () => {
    const reader = await resolveWorkspaceSkills('missing', { store, manager: global });
    expect(reader).to.equal(null);
  });

  it('serves only global skills when the workspace has no .agents/skills [unit]', async () => {
    const { workspace } = makeWorkspace('plain');
    const reader = await resolveWorkspaceSkills(workspace.id, { store, manager: global });
    expect(reader?.list().map((s) => s.name)).to.have.members(['global-skill', 'create-project']);
  });

  // The remote gate was deliberately dropped: skills are read from disk, so a
  // local-only workspace with .agents/skills gets them too.
  it('serves repo skills from a workspace with no git remote [unit]', async () => {
    const { workspace, location } = makeWorkspace('local-only', null);
    writeSkill(join(location, '.agents', 'skills'), 'repo-skill', 'repo body');
    const reader = await resolveWorkspaceSkills(workspace.id, { store, manager: global });
    const repo = reader?.list().find((s) => s.name === 'repo-skill');
    expect(repo, 'repo skill should be listed').to.include({ source: 'repo' });
    expect((await reader!.lookup('repo-skill')).trim()).to.equal('repo body');
  });

  it('reflects skills added to the directory after an earlier resolve [unit]', async () => {
    const { workspace, location } = makeWorkspace('fresh');
    await resolveWorkspaceSkills(workspace.id, { store, manager: global });
    writeSkill(join(location, '.agents', 'skills'), 'added-later', 'late body');
    const reader = await resolveWorkspaceSkills(workspace.id, { store, manager: global });
    expect((await reader!.lookup('added-later')).trim()).to.equal('late body');
  });

  // Gated skill names unlock privileged tools; a repo must never be able to
  // swap in its own instructions for them.
  it('never lets a repo override a gated skill name [unit]', async () => {
    const { workspace, location } = makeWorkspace('hijack', 'https://example.com/r.git');
    writeSkill(join(location, '.agents', 'skills'), 'create-project', 'repo hijack body');
    const reader = await resolveWorkspaceSkills(workspace.id, { store, manager: global });
    expect((await reader!.lookup('create-project')).trim()).to.equal('global gated body');
  });

  it('refuses writes through the returned reader [unit]', async () => {
    const { workspace, location } = makeWorkspace('ro');
    writeSkill(join(location, '.agents', 'skills'), 'repo-skill', 'repo body');
    const reader = (await resolveWorkspaceSkills(workspace.id, {
      store,
      manager: global,
    })) as unknown as SkillsManager;
    let error: unknown;
    try {
      await reader.edit('repo-skill', { description: 'changed' });
    } catch (err) {
      error = err;
    }
    expect((error as Error).message).to.include('read-only');
  });
});
