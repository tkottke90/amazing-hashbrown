import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsManager } from '../../src/skills-manager.js';
import { writeSkill, writeValidSkill } from './fixtures.js';

describe('SkillsManager.inspect', () => {
  let root: string;
  let manager: SkillsManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skills-manager-inspect-test-'));
    manager = new SkillsManager(root);
    await manager.boot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports exists: false for a name with no directory [unit]', async () => {
    const result = await manager.inspect('nope');
    expect(result).to.deep.equal({ exists: false });
  });

  it('returns frontmatter/body with no issue for a skill that boots fine [unit]', async () => {
    await writeValidSkill(root, 'healthy-skill', 'Body text.');
    const result = await manager.inspect('healthy-skill');
    expect(result.exists).to.equal(true);
    expect(result.issue).to.equal(undefined);
    expect(result.frontmatter?.name).to.equal('healthy-skill');
    expect(result.frontmatter?.description).to.equal('Description of healthy-skill');
    expect(result.body?.trim()).to.equal('Body text.');
    expect(result.nameMismatch).to.equal(false);
  });

  it('returns an issue (not a throw) for a missing required field [unit]', async () => {
    await writeSkill(root, 'no-name', { description: 'Has no name field' });
    const result = await manager.inspect('no-name');
    expect(result.exists).to.equal(true);
    expect(result.frontmatter).to.equal(undefined);
    expect(result.issue).to.match(/missing required field: name/);
  });

  it('returns an issue (not a throw) for an invalid name format [unit]', async () => {
    await writeSkill(root, 'Bad_Name', { name: 'Bad_Name', description: 'Invalid name format' });
    const result = await manager.inspect('Bad_Name');
    expect(result.exists).to.equal(true);
    expect(result.frontmatter).to.equal(undefined);
    expect(result.issue).to.match(/Invalid skill name/);
  });

  it('returns an issue (not a throw) for malformed YAML frontmatter [unit]', async () => {
    const dir = join(root, 'broken-yaml');
    await mkdir(dir, { recursive: true });
    // Unterminated flow sequence — gray-matter/js-yaml throws parsing this,
    // independently of validateFrontmatter's own field-level checks.
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: broken-yaml\ndescription: [unterminated\n---\nBody\n',
      'utf8',
    );
    const result = await manager.inspect('broken-yaml');
    expect(result.exists).to.equal(true);
    expect(result.frontmatter).to.equal(undefined);
    expect(result.body).to.equal(undefined);
    expect(result.issue).to.be.a('string');
    expect(result.issue?.length).to.be.greaterThan(0);
  });

  it('reports nameMismatch when frontmatter name differs from the directory [unit]', async () => {
    await writeSkill(root, 'actual-dir', { name: 'different-name', description: 'Mismatched' });
    const result = await manager.inspect('actual-dir');
    expect(result.exists).to.equal(true);
    expect(result.nameMismatch).to.equal(true);
    expect(result.frontmatter?.name).to.equal('different-name');
  });

  it('inventories scripts/references independently of whether an issue is set [unit]', async () => {
    await writeSkill(root, 'no-name-with-scripts', { description: 'Has no name field' });
    await mkdir(join(root, 'no-name-with-scripts', 'scripts'), { recursive: true });
    await writeFile(join(root, 'no-name-with-scripts', 'scripts', 'run.js'), '// noop', 'utf8');

    const result = await manager.inspect('no-name-with-scripts');
    expect(result.issue).to.be.a('string');
    expect(result.scripts).to.have.property('run.js');
  });

  it('works whether or not boot() was ever called on the instance [unit]', async () => {
    // A fresh, never-booted manager — the direct regression test for the
    // cache-bypass fix: inspect() must not depend on boot()'s cache at all.
    const unbootedManager = new SkillsManager(root);
    await writeValidSkill(root, 'never-booted', 'Body.');

    const result = await unbootedManager.inspect('never-booted');
    expect(result.exists).to.equal(true);
    expect(result.issue).to.equal(undefined);
    expect(result.frontmatter?.name).to.equal('never-booted');
  });

  it('reaches a skill broken enough to be skipped at boot() [unit]', async () => {
    // This skill fails boot() validation (missing name) and is therefore
    // never in the cache — load()/lookup() can't reach it, but inspect()
    // must, since that's exactly the case repair exists for.
    await writeSkill(root, 'boot-skipped', { description: 'No name, skipped at boot' });
    const bootResult = await manager.boot();
    expect(bootResult.skipped.some((s) => s.dir === 'boot-skipped')).to.equal(true);

    const result = await manager.inspect('boot-skipped');
    expect(result.exists).to.equal(true);
    expect(result.issue).to.match(/missing required field: name/);
  });
});
