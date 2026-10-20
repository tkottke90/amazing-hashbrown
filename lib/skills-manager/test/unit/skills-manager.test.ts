import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsManager } from '../../src/skills-manager.js';

async function makeManager(): Promise<{ manager: SkillsManager; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'skills-manager-test-'));
  const manager = new SkillsManager(root);
  await manager.boot();
  return { manager, root };
}

describe('SkillsManager', () => {
  let manager: SkillsManager;
  let root: string;

  beforeEach(async () => {
    ({ manager, root } = await makeManager());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a skill and round-trips it through load()', async () => {
      await manager.create({ name: 'my-skill', description: 'Does a thing', body: 'Body text.' });
      const skill = await manager.load('my-skill');
      expect(skill.name).to.equal('my-skill');
      expect(skill.frontmatter.description).to.equal('Does a thing');
      // serialize()/gray-matter appends a trailing newline to the body on write
      expect(skill.body.trim()).to.equal('Body text.');
      expect(skill.enabled).to.equal(true);
      expect(skill.slashCommand).to.equal('/my-skill');
    });

    it('throws on duplicate name', async () => {
      await manager.create({ name: 'dup-skill', description: 'First', body: 'x' });
      let error: unknown;
      try {
        await manager.create({ name: 'dup-skill', description: 'Second', body: 'y' });
      } catch (err) {
        error = err;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('already exists');
    });

    for (const badName of ['Has Spaces', 'UPPERCASE', '-leading-hyphen', 'a'.repeat(65)]) {
      it(`throws on invalid name "${badName.slice(0, 20)}..."`, async () => {
        let error: unknown;
        try {
          await manager.create({ name: badName, description: 'x', body: 'y' });
        } catch (err) {
          error = err;
        }
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('Invalid skill name');
      });
    }
  });

  describe('edit', () => {
    beforeEach(async () => {
      await manager.create({ name: 'edit-me', description: 'Original', body: 'Original body' });
    });

    it('updates description and body', async () => {
      await manager.edit('edit-me', { description: 'Updated', body: 'Updated body' });
      const skill = await manager.load('edit-me');
      expect(skill.frontmatter.description).to.equal('Updated');
      expect(skill.body.trim()).to.equal('Updated body');
    });

    it('round-trips enabled: false then true through Skill.enabled', async () => {
      await manager.edit('edit-me', { enabled: false });
      let skill = await manager.load('edit-me');
      expect(skill.enabled).to.equal(false);

      await manager.edit('edit-me', { enabled: true });
      skill = await manager.load('edit-me');
      expect(skill.enabled).to.equal(true);
    });

    it('throws on unknown name', async () => {
      let error: unknown;
      try {
        await manager.edit('does-not-exist', { description: 'x' });
      } catch (err) {
        error = err;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('not found');
    });
  });

  describe('delete', () => {
    it('removes the skill directory and cache entry', async () => {
      await manager.create({ name: 'delete-me', description: 'x', body: 'y' });
      await manager.delete('delete-me');
      expect(manager.list().some((s) => s.name === 'delete-me')).to.equal(false);
      let error: unknown;
      try {
        await manager.load('delete-me');
      } catch (err) {
        error = err;
      }
      expect(error).to.be.instanceOf(Error);
    });

    it('throws on unknown name', async () => {
      let error: unknown;
      try {
        await manager.delete('does-not-exist');
      } catch (err) {
        error = err;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('not found');
    });
  });

  describe('list', () => {
    it('returns skills sorted alphabetically by name, not creation order', async () => {
      await manager.create({ name: 'zebra-skill', description: 'x', body: 'y' });
      await manager.create({ name: 'apple-skill', description: 'x', body: 'y' });
      await manager.create({ name: 'mango-skill', description: 'x', body: 'y' });
      expect(manager.list().map((s) => s.name)).to.deep.equal([
        'apple-skill',
        'mango-skill',
        'zebra-skill',
      ]);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await manager.create({ name: 'apple-skill', description: 'x', body: 'y' });
      await manager.create({ name: 'banana-skill', description: 'x', body: 'y' });
      await manager.create({ name: 'cherry-skill', description: 'x', body: 'y' });
      await manager.create({ name: 'fig-skill', description: 'x', body: 'y' });
    });

    it('returns all enabled skills sorted alphabetically when no keyword is given', () => {
      expect(manager.search().map((s) => s.name)).to.deep.equal([
        'apple-skill',
        'banana-skill',
        'cherry-skill',
        'fig-skill',
      ]);
    });

    it('preserves alphabetical order within a keyword-filtered subset', () => {
      // 'a' matches apple-skill and banana-skill only, not cherry-skill or fig-skill.
      expect(manager.search('a').map((s) => s.name)).to.deep.equal(['apple-skill', 'banana-skill']);
    });
  });

  describe('file management (scripts / references)', () => {
    beforeEach(async () => {
      await manager.create({ name: 'file-skill', description: 'x', body: 'y' });
    });

    for (const dir of ['scripts', 'references'] as const) {
      it(`writes then reads a file under ${dir}`, async () => {
        await manager.writeFile('file-skill', dir, 'note.txt', 'hello world');
        const content = await manager.readFile('file-skill', dir, 'note.txt');
        expect(content).to.equal('hello world');
      });

      it(`deletes a file under ${dir}`, async () => {
        await manager.writeFile('file-skill', dir, 'note.txt', 'hello world');
        await manager.deleteFile('file-skill', dir, 'note.txt');
        let error: unknown;
        try {
          await manager.readFile('file-skill', dir, 'note.txt');
        } catch (err) {
          error = err;
        }
        expect(error).to.not.equal(undefined);
      });
    }

    it('rejects reading a missing file (ENOENT)', async () => {
      let error: unknown;
      try {
        await manager.readFile('file-skill', 'scripts', 'missing.txt');
      } catch (err) {
        error = err;
      }
      expect(error).to.not.equal(undefined);
      expect((error as NodeJS.ErrnoException).code).to.equal('ENOENT');
    });

    it('throws when operating on an unknown skill', async () => {
      let error: unknown;
      try {
        await manager.writeFile('no-such-skill', 'scripts', 'note.txt', 'hi');
      } catch (err) {
        error = err;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('not found');
    });
  });

  describe('evals', () => {
    beforeEach(async () => {
      await manager.create({ name: 'eval-skill', description: 'x', body: 'y' });
    });

    it('throws the "No evals found" message when none exist yet', async () => {
      let error: unknown;
      try {
        await manager.loadEvals('eval-skill');
      } catch (err) {
        error = err;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('No evals found for skill');
    });

    it('saves then loads a suite', async () => {
      const suite = {
        skill_name: 'eval-skill',
        evals: [
          {
            id: 1,
            prompt: 'Do the thing',
            expected_output: 'The thing is done',
            assertions: ['mentions the thing'],
          },
        ],
      };
      await manager.saveEvals('eval-skill', suite);
      const loaded = await manager.loadEvals('eval-skill');
      expect(loaded).to.deep.equal(suite);
    });
  });

  // The actual spawn/timeout/context-serialization logic is covered in
  // internal/runner.test.ts (mocking child_process.spawn directly) — these
  // just confirm SkillsManager delegates with the right path and args.
  describe('runScript/runPythonScript/runShellScript', () => {
    beforeEach(async () => {
      await manager.create({ name: 'script-skill', description: 'x', body: 'y' });
    });

    it('runScript runs a real .js script and returns a uniform ScriptResult', async () => {
      await manager.writeFile(
        'script-skill',
        'scripts',
        'hello.js',
        'console.log(process.argv.slice(2).join(","))',
      );
      const result = await manager.runScript('script-skill', 'hello.js', { args: ['a', 'b'] });
      expect(result.stdout.trim()).to.equal('a,b');
      expect(result.exitCode).to.equal(0);
    });

    it('runScript delivers context via SKILL_SCRIPT_CONTEXT as JSON', async () => {
      await manager.writeFile(
        'script-skill',
        'scripts',
        'ctx.js',
        'console.log(JSON.parse(process.env.SKILL_SCRIPT_CONTEXT).filePath)',
      );
      const result = await manager.runScript('script-skill', 'ctx.js', {
        context: { filePath: '/tmp/doc.pdf' },
      });
      expect(result.stdout.trim()).to.equal('/tmp/doc.pdf');
    });

    it('runPythonScript passes args through to the real interpreter', async () => {
      await manager.writeFile(
        'script-skill',
        'scripts',
        'hello.py',
        'import sys\nprint(",".join(sys.argv[1:]))',
      );
      const result = await manager.runPythonScript('script-skill', 'hello.py', ['x', 'y']);
      expect(result.stdout.trim()).to.equal('x,y');
      expect(result.exitCode).to.equal(0);
    });

    it('runShellScript runs a real shell script and returns a uniform ScriptResult', async () => {
      await manager.writeFile('script-skill', 'scripts', 'hello.sh', 'echo "$1"');
      const result = await manager.runShellScript('script-skill', 'hello.sh', ['hi']);
      expect(result.stdout.trim()).to.equal('hi');
      expect(result.exitCode).to.equal(0);
    });

    it('reports a non-zero exit for a script file that does not exist', async () => {
      const result = await manager.runShellScript('script-skill', 'missing.sh');
      expect(result.exitCode).to.not.equal(0);
    });
  });
});
