import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { SkillsManager } from '@tkottke90/skills-manager';
import {
  searchSkillsHandler,
  getSkillHandler,
  createSkillHandler,
  editSkillHandler,
  deleteSkillHandler,
  readSkillFileHandler,
  writeSkillFileHandler,
  deleteSkillFileHandler,
  getSkillEvalsHandler,
  saveSkillEvalsHandler,
} from './skills.handlers.js';

async function makeManager(): Promise<{ manager: SkillsManager; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-handlers-test-'));
  const manager = new SkillsManager(root);
  await manager.boot();
  return { manager, root };
}

const GATED_NAMES = ['create-workspace'];

describe('skills.handlers', () => {
  let manager: SkillsManager;
  let root: string;

  beforeEach(async () => {
    ({ manager, root } = await makeManager());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('searchSkillsHandler', () => {
    beforeEach(async () => {
      await manager.create({ name: 'enabled-skill', description: 'On', body: 'x' });
      await manager.create({ name: 'disabled-skill', description: 'Off', body: 'x' });
      await manager.edit('disabled-skill', { enabled: false });
    });

    it('excludes disabled skills by default', () => {
      const result = searchSkillsHandler(manager, undefined, false);
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      const names = result.data.skills.map((s) => s.name);
      expect(names).to.include('enabled-skill');
      expect(names).to.not.include('disabled-skill');
    });

    it('includes disabled skills when all=true', () => {
      const result = searchSkillsHandler(manager, undefined, true);
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      const names = result.data.skills.map((s) => s.name);
      expect(names).to.include('enabled-skill');
      expect(names).to.include('disabled-skill');
    });

    it('filters by keyword', () => {
      const result = searchSkillsHandler(manager, 'enabled-skill', false);
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.skills.map((s) => s.name)).to.deep.equal(['enabled-skill']);
    });
  });

  describe('getSkillHandler', () => {
    it('404s for an unknown skill', async () => {
      const result = await getSkillHandler(manager, 'no-such-skill');
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(404);
    });

    it('returns the full skill for a known name', async () => {
      await manager.create({ name: 'full-skill', description: 'x', body: 'body text' });
      const result = await getSkillHandler(manager, 'full-skill');
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.name).to.equal('full-skill');
      expect(result.data.body.trim()).to.equal('body text');
    });
  });

  describe('createSkillHandler', () => {
    it('creates a skill on a valid body', async () => {
      const result = await createSkillHandler(manager, {
        name: 'new-skill',
        description: 'A new skill',
        body: 'Do the thing.',
      });
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.name).to.equal('new-skill');
    });

    it('400s with fieldErrors when required fields are missing', async () => {
      const result = await createSkillHandler(manager, { body: 'x' });
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
      expect(result.fieldErrors).to.have.property('name');
      expect(result.fieldErrors).to.have.property('description');
    });

    it('400s for a manager-rejected invalid name', async () => {
      const result = await createSkillHandler(manager, {
        name: 'Bad Name!',
        description: 'x',
        body: 'y',
      });
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
    });

    it('409s on a duplicate name', async () => {
      await manager.create({ name: 'dup', description: 'x', body: 'y' });
      const result = await createSkillHandler(manager, {
        name: 'dup',
        description: 'x',
        body: 'y',
      });
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(409);
    });
  });

  describe('editSkillHandler', () => {
    beforeEach(async () => {
      await manager.create({ name: 'edit-target', description: 'Original', body: 'Original' });
    });

    it('404s for an unknown skill', async () => {
      const result = await editSkillHandler(manager, 'no-such-skill', { description: 'x' });
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(404);
    });

    it('updates description/body/enabled and round-trips through getSkillHandler', async () => {
      const editResult = await editSkillHandler(manager, 'edit-target', {
        description: 'Updated',
        body: 'Updated body',
        enabled: false,
      });
      expect(editResult.ok).to.equal(true);

      const getResult = await getSkillHandler(manager, 'edit-target');
      expect(getResult.ok).to.equal(true);
      if (!getResult.ok) return;
      expect(getResult.data.frontmatter.description).to.equal('Updated');
      expect(getResult.data.body.trim()).to.equal('Updated body');
      expect(getResult.data.enabled).to.equal(false);
    });

    it('400s for a non-boolean enabled value', async () => {
      const result = await editSkillHandler(manager, 'edit-target', { enabled: 'yes' });
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
    });
  });

  describe('deleteSkillHandler', () => {
    it('404s for an unknown skill', async () => {
      const result = await deleteSkillHandler(manager, 'no-such-skill', GATED_NAMES);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(404);
    });

    it('deletes a non-gated skill', async () => {
      await manager.create({ name: 'delete-me', description: 'x', body: 'y' });
      const result = await deleteSkillHandler(manager, 'delete-me', GATED_NAMES);
      expect(result.ok).to.equal(true);
      expect(manager.list().some((s) => s.name === 'delete-me')).to.equal(false);
    });

    it('409s for a gated skill and leaves it in place', async () => {
      await manager.create({ name: 'create-workspace', description: 'x', body: 'y' });
      const result = await deleteSkillHandler(manager, 'create-workspace', GATED_NAMES);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(409);
      expect(manager.list().some((s) => s.name === 'create-workspace')).to.equal(true);
    });
  });

  describe('file handlers (scripts / references)', () => {
    beforeEach(async () => {
      await manager.create({ name: 'file-owner', description: 'x', body: 'y' });
    });

    it('400s for a dir outside scripts|references', async () => {
      const result = await readSkillFileHandler(manager, 'file-owner', 'evals', 'notes.txt');
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
    });

    for (const badBasename of ['../../../etc/passwd', 'a/b', '..', '']) {
      it(`400s for a path-traversal basename "${badBasename}"`, async () => {
        const result = await readSkillFileHandler(manager, 'file-owner', 'scripts', badBasename);
        expect(result.ok).to.equal(false);
        if (result.ok) return;
        expect(result.status).to.equal(400);
      });
    }

    it('writes then reads a file, then deletes it', async () => {
      const writeResult = await writeSkillFileHandler(manager, 'file-owner', 'scripts', 'run.js', {
        content: 'console.log(1);',
      });
      expect(writeResult.ok).to.equal(true);

      const readResult = await readSkillFileHandler(manager, 'file-owner', 'scripts', 'run.js');
      expect(readResult.ok).to.equal(true);
      if (!readResult.ok) return;
      expect(readResult.data.content).to.equal('console.log(1);');

      const deleteResult = await deleteSkillFileHandler(manager, 'file-owner', 'scripts', 'run.js');
      expect(deleteResult.ok).to.equal(true);

      const afterDelete = await readSkillFileHandler(manager, 'file-owner', 'scripts', 'run.js');
      expect(afterDelete.ok).to.equal(false);
      if (afterDelete.ok) return;
      expect(afterDelete.status).to.equal(404);
    });
  });

  describe('evals handlers', () => {
    beforeEach(async () => {
      await manager.create({ name: 'eval-owner', description: 'x', body: 'y' });
    });

    it('returns an empty suite when none exists yet', async () => {
      const result = await getSkillEvalsHandler(manager, 'eval-owner');
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data).to.deep.equal({ skill_name: 'eval-owner', evals: [] });
    });

    it('404s save for an unknown skill', async () => {
      const result = await saveSkillEvalsHandler(manager, 'no-such-skill', {
        skill_name: 'no-such-skill',
        evals: [],
      });
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(404);
    });

    it('400s save for a malformed body', async () => {
      const result = await saveSkillEvalsHandler(manager, 'eval-owner', {
        skill_name: 'eval-owner',
      });
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
    });

    it('saves then reads back the suite', async () => {
      const suite = {
        skill_name: 'eval-owner',
        evals: [{ id: 1, prompt: 'Do it', expected_output: 'Done' }],
      };
      const saveResult = await saveSkillEvalsHandler(manager, 'eval-owner', suite);
      expect(saveResult.ok).to.equal(true);

      const getResult = await getSkillEvalsHandler(manager, 'eval-owner');
      expect(getResult.ok).to.equal(true);
      if (!getResult.ok) return;
      expect(getResult.data).to.deep.equal(suite);
    });
  });
});
