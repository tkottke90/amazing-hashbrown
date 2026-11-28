import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { SkillsManager } from '@tkottke90/skills-manager';
import { expandSkill } from './skill-expansion.js';

describe('agents/skill-expansion', () => {
  let manager: SkillsManager;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skill-expansion-helper-test-'));
    manager = new SkillsManager(dir);
    await manager.boot();
    await manager.create({
      name: 'plain',
      description: 'No artifacts.',
      body: 'Plain skill body.',
    });
    await manager.create({
      name: 'with-artifacts',
      description: 'Has a reference on disk.',
      body: 'Skill body with artifacts.',
    });
    await manager.writeFile('with-artifacts', 'references', 'notes.md', '# notes');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(`returns the bare body when the skill has no artifacts and no args ${'[unit]'}`, async () => {
    const { body } = await manager.load('plain');
    const result = await expandSkill(manager, 'plain');
    expect(result).to.deep.equal({ ok: true, text: body });
  });

  it(`appends args after the body ${'[unit]'}`, async () => {
    const { body } = await manager.load('plain');
    const result = await expandSkill(manager, 'plain', 'do the thing');
    expect(result).to.deep.equal({ ok: true, text: `${body}\n\ndo the thing` });
  });

  it(`appends the Artifact Index after the body so the skill can reach its own references ${'[unit]'}`, async () => {
    const result = await expandSkill(manager, 'with-artifacts');
    expect(result.ok).to.equal(true);
    if (!result.ok) return;
    expect(result.text.startsWith('Skill body with artifacts.')).to.equal(true);
    expect(result.text).to.include('read_skill_reference');
    expect(result.text).to.include('notes.md');
  });

  it(`places args between the body and the Artifact Index ${'[unit]'}`, async () => {
    const result = await expandSkill(manager, 'with-artifacts', 'extra args');
    expect(result.ok).to.equal(true);
    if (!result.ok) return;
    expect(result.text.indexOf('extra args')).to.be.greaterThan(result.text.indexOf('Skill body'));
    expect(result.text.indexOf('extra args')).to.be.lessThan(result.text.indexOf('notes.md'));
  });

  it(`reports ok:false instead of throwing for an unknown skill ${'[unit]'}`, async () => {
    const result = await expandSkill(manager, 'does-not-exist');
    expect(result).to.deep.equal({ ok: false });
  });
});
