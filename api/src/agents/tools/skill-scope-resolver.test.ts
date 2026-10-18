import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SkillsManager } from '@tkottke90/skills-manager';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { WORKSPACE_SKILLS_DIR } from '../../services/workspace-skills.js';
import { resolveSkillScope } from './skill-scope-resolver.js';

function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`,
  );
}

// resolveSkillScope is the single place that decides, for a bare skill
// name, whether a create-skill tool should operate on the global manager or
// a workspace's own .agents/skills — and refuses to guess when both have it.
describe('agents/tools/skill-scope-resolver — resolveSkillScope', () => {
  let dir: string;
  let store: WorkspaceStore;
  let global: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skill-scope-resolver-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    const globalRoot = join(dir, 'global-skills');
    writeSkill(globalRoot, 'global-only', 'global body');
    writeSkill(globalRoot, 'shared-name', 'global version');
    global = new SkillsManager(globalRoot);
    await global.boot();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeWorkspace(name: string) {
    const location = join(dir, name);
    mkdirSync(location, { recursive: true });
    return { location, workspace: store.createWorkspace({ name, location, remoteUrl: null }) };
  }

  it('resolves to the global manager when the skill exists only there [unit]', async () => {
    const result = await resolveSkillScope('global-only', undefined, {
      globalManager: global,
      store,
    });
    expect(result.kind).to.equal('found');
    if (result.kind === 'found') {
      expect(result.scope).to.equal('app');
    }
  });

  it('resolves to a workspace manager when the skill exists only there [unit]', async () => {
    const { workspace, location } = makeWorkspace('ws-only');
    writeSkill(join(location, WORKSPACE_SKILLS_DIR), 'workspace-only', 'workspace body');

    const result = await resolveSkillScope('workspace-only', workspace.id, {
      globalManager: global,
      store,
    });
    expect(result.kind).to.equal('found');
    if (result.kind === 'found') {
      expect(result.scope).to.equal('workspace');
      const inspection = await result.manager.inspect('workspace-only');
      expect(inspection.body?.trim()).to.equal('workspace body');
    }
  });

  it('returns ambiguous when the same name exists in both scopes [unit]', async () => {
    const { workspace, location } = makeWorkspace('collide');
    writeSkill(join(location, WORKSPACE_SKILLS_DIR), 'shared-name', 'workspace version');

    const result = await resolveSkillScope('shared-name', workspace.id, {
      globalManager: global,
      store,
    });
    expect(result.kind).to.equal('ambiguous');
  });

  it('returns not-found when the skill exists in neither scope [unit]', async () => {
    const { workspace } = makeWorkspace('empty');
    const result = await resolveSkillScope('nowhere', workspace.id, {
      globalManager: global,
      store,
    });
    expect(result.kind).to.equal('not-found');
  });

  it('checks only the global scope when no workspaceId is given [unit]', async () => {
    const result = await resolveSkillScope('global-only', undefined, {
      globalManager: global,
      store,
    });
    expect(result.kind).to.equal('found');
  });

  it('falls back to global-only resolution for an unknown workspace id [unit]', async () => {
    const result = await resolveSkillScope('global-only', 'does-not-exist', {
      globalManager: global,
      store,
    });
    expect(result.kind).to.equal('found');
    if (result.kind === 'found') {
      expect(result.scope).to.equal('app');
    }
  });
});
