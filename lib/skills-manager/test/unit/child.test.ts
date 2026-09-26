import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShellExecutor } from '@tkottke90/shell-executor';
import { SkillsManager } from '../../src/skills-manager.js';
import { snapshot, writeSkill, writeValidSkill } from './fixtures.js';

async function expectReadOnly(action: () => Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await action();
  } catch (err) {
    error = err;
  }
  expect(error, 'write/exec on a child manager must throw').to.be.instanceOf(Error);
  expect((error as Error).message).to.include('read-only');
}

// A child manager layers a read-only directory (e.g. a repo's
// .agents/skills) over a parent. These tests pin the three guarantees the
// workspace feature depends on: child-first resolution with parent
// fall-through, reserved names the child can never take over, and no write
// or script execution through a child under any circumstances.
describe('SkillsManager.createChild', () => {
  let tmp: string;
  let parentRoot: string;
  let childRoot: string;
  let parent: SkillsManager;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'skills-manager-child-'));
    parentRoot = join(tmp, 'global');
    childRoot = join(tmp, 'repo');
    await writeValidSkill(parentRoot, 'shared', 'global shared body');
    await writeValidSkill(parentRoot, 'global-only', 'global only body');
    await writeValidSkill(parentRoot, 'create-project', 'global gated body');
    parent = new SkillsManager(parentRoot);
    await parent.boot();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function bootChild(reserved: string[] = []): Promise<SkillsManager> {
    const child = parent.createChild(childRoot, { source: 'repo', reserved });
    await child.boot();
    return child;
  }

  describe('resolution', () => {
    it("serves the child's own skill over a same-named parent skill [unit]", async () => {
      await writeValidSkill(childRoot, 'shared', 'repo shared body');
      const child = await bootChild();
      expect((await child.lookup('shared')).trim()).to.equal('repo shared body');
      expect((await child.load('shared')).path).to.equal(join(childRoot, 'shared'));
    });

    it('falls through to the parent for skills the child does not have [unit]', async () => {
      const child = await bootChild();
      expect((await child.lookup('global-only')).trim()).to.equal('global only body');
      expect((await child.load('global-only')).path).to.equal(join(parentRoot, 'global-only'));
    });

    it('throws not-found when neither child nor parent has the skill [unit]', async () => {
      const child = await bootChild();
      let error: unknown;
      try {
        await child.lookup('nowhere');
      } catch (err) {
        error = err;
      }
      expect((error as Error).message).to.include('not found');
    });

    it('serves parent skills when the child directory does not exist [unit]', async () => {
      const child = await bootChild();
      const result = await child.boot();
      expect(result.skipped).to.deep.equal([]);
      expect(child.list().map((s) => s.name)).to.have.members([
        'shared',
        'global-only',
        'create-project',
      ]);
    });

    it('sees parent edits made after the child booted [unit]', async () => {
      const child = await bootChild();
      await parent.create({ name: 'late-skill', description: 'Added later', body: 'late' });
      expect((await child.lookup('late-skill')).trim()).to.equal('late');
    });
  });

  describe('reserved names', () => {
    // Gated skills unlock privileged tools by name; a repo shipping its own
    // create-project must never replace the instructions that run while
    // create_project is exposed.
    it('skips a reserved child skill, reports it, and serves the parent version [unit]', async () => {
      await writeValidSkill(childRoot, 'create-project', 'repo hijack body');
      const child = parent.createChild(childRoot, { source: 'repo', reserved: ['create-project'] });
      const result = await child.boot();
      expect(result.skipped).to.deep.equal([{ dir: 'create-project', reason: 'reserved' }]);
      expect((await child.lookup('create-project')).trim()).to.equal('global gated body');
      const summary = child.list().find((s) => s.name === 'create-project');
      expect(summary?.source).to.equal('global');
    });
  });

  describe('disabled child skills', () => {
    it('treats a disabled child skill as absent so the parent version shows [unit]', async () => {
      await writeSkill(childRoot, 'shared', {
        name: 'shared',
        description: 'disabled repo copy',
        body: 'repo disabled body',
        enabled: false,
      });
      const child = await bootChild();
      expect((await child.lookup('shared')).trim()).to.equal('global shared body');
      expect(child.list().find((s) => s.name === 'shared')?.source).to.equal('global');
    });
  });

  describe('list / search', () => {
    beforeEach(async () => {
      await writeValidSkill(childRoot, 'shared', 'repo shared body');
      await writeValidSkill(childRoot, 'repo-only', 'repo only body');
    });

    it('merges parent and child with source labels and one entry per name [unit]', async () => {
      const child = await bootChild();
      const byName = new Map(child.list().map((s) => [s.name, s]));
      expect([...byName.keys()]).to.have.members([
        'shared',
        'global-only',
        'create-project',
        'repo-only',
      ]);
      expect(child.list()).to.have.length(4);
      expect(byName.get('global-only')).to.include({ source: 'global' });
      expect(byName.get('repo-only')).to.include({ source: 'repo' });
      expect(byName.get('repo-only')?.overrides).to.equal(undefined);
    });

    it('marks a child skill that shadows a parent skill as overrides [unit]', async () => {
      const child = await bootChild();
      const shared = child.list().find((s) => s.name === 'shared');
      expect(shared).to.include({ source: 'repo', overrides: true });
    });

    it('filters the merged set by keyword [unit]', async () => {
      const child = await bootChild();
      expect(child.search('repo-only').map((s) => s.name)).to.deep.equal(['repo-only']);
      expect(child.search('global-only').map((s) => s.name)).to.deep.equal(['global-only']);
    });

    it('leaves the parent listing untouched [unit]', async () => {
      await bootChild();
      expect(parent.list().map((s) => s.source)).to.deep.equal(['global', 'global', 'global']);
    });
  });

  describe('read-only guarantees', () => {
    let child: SkillsManager;
    let before: { parent: string[]; child: string[] };

    beforeEach(async () => {
      await writeValidSkill(childRoot, 'repo-only');
      child = await bootChild();
      before = { parent: await snapshot(parentRoot), child: await snapshot(childRoot) };
    });

    afterEach(async () => {
      expect(await snapshot(parentRoot), 'parent dir must be unchanged').to.deep.equal(
        before.parent,
      );
      expect(await snapshot(childRoot), 'child dir must be unchanged').to.deep.equal(before.child);
    });

    const writeOps: Array<[string, (m: SkillsManager, name: string) => Promise<unknown>]> = [
      ['create', (m) => m.create({ name: 'new-skill', description: 'x', body: 'y' })],
      ['edit', (m, n) => m.edit(n, { description: 'changed' })],
      ['delete', (m, n) => m.delete(n)],
      ['writeFile', (m, n) => m.writeFile(n, 'scripts', 'a.js', 'x')],
      ['deleteFile', (m, n) => m.deleteFile(n, 'scripts', 'a.js')],
      ['saveEvals', (m, n) => m.saveEvals(n, { skill_name: n, evals: [] })],
      ['runScript', (m, n) => m.runScript(n, 'a.js')],
      ['runPythonScript', (m, n) => m.runPythonScript(n, 'a.py')],
    ];

    for (const [op, call] of writeOps) {
      it(`rejects ${op} on the child's own skill [unit]`, async () => {
        await expectReadOnly(() => call(child, 'repo-only'));
      });

      // A workspace-scoped handle must never mutate or execute a global skill
      // by passing the call up to the parent.
      it(`rejects ${op} on a parent-owned skill [unit]`, async () => {
        await expectReadOnly(() => call(child, 'global-only'));
      });
    }

    it('rejects runScript before the runner reaches the executor [unit]', async () => {
      let executed = false;
      const spy = {
        execute: async () => {
          executed = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      } as unknown as ShellExecutor;
      parent.setExecutor(spy);
      await expectReadOnly(() => child.runPythonScript('repo-only', 'a.py'));
      expect(executed, 'executor must never be invoked for a child').to.equal(false);
    });
  });
});
