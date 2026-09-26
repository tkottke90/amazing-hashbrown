import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsManager } from '../../src/skills-manager.js';
import { writeSkill, writeValidSkill } from './fixtures.js';

describe('SkillsManager.boot', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skills-manager-boot-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports nothing skipped when every skill is valid [unit]', async () => {
    await writeValidSkill(root, 'good-skill');
    const manager = new SkillsManager(root);
    const result = await manager.boot();
    expect(result.skipped).to.deep.equal([]);
    expect(manager.list().map((s) => s.name)).to.deep.equal(['good-skill']);
  });

  // A skill whose frontmatter name differs from its directory would appear in
  // the slash menu but fail on use, because lookup() builds the path from the
  // name. It must be rejected at boot and explained, not listed.
  it('skips and reports a skill whose name does not match its directory [unit]', async () => {
    await writeSkill(root, 'deploy-tool', { name: 'deploy', description: 'Deploys' });
    const manager = new SkillsManager(root);
    const result = await manager.boot();
    expect(result.skipped).to.have.length(1);
    expect(result.skipped[0]).to.include({ dir: 'deploy-tool', reason: 'name-mismatch' });
    expect(manager.list(), 'mismatched skill must not be listed').to.deep.equal([]);
  });

  it('skips and reports invalid frontmatter with the validation message [unit]', async () => {
    await writeSkill(root, 'no-desc', { name: 'no-desc' });
    const manager = new SkillsManager(root);
    const result = await manager.boot();
    expect(result.skipped).to.have.length(1);
    expect(result.skipped[0]).to.include({ dir: 'no-desc', reason: 'invalid-frontmatter' });
    expect(result.skipped[0]?.detail).to.include('description');
  });

  it('keeps loading valid skills when a sibling is malformed [unit]', async () => {
    await writeValidSkill(root, 'good-skill');
    await writeSkill(root, 'broken', { description: 'no name' });
    const manager = new SkillsManager(root);
    await manager.boot();
    expect(manager.list().map((s) => s.name)).to.deep.equal(['good-skill']);
  });

  it("labels every summary from a root manager with source 'global' [unit]", async () => {
    await writeValidSkill(root, 'good-skill');
    const manager = new SkillsManager(root);
    await manager.boot();
    await manager.create({ name: 'created-skill', description: 'x', body: 'y' });
    expect(manager.list().map((s) => s.source)).to.deep.equal(['global', 'global']);
  });

  it('returns an empty report for a missing root directory [unit]', async () => {
    const manager = new SkillsManager(join(root, 'does-not-exist'));
    const result = await manager.boot();
    expect(result.skipped).to.deep.equal([]);
    expect(manager.list()).to.deep.equal([]);
  });
});
