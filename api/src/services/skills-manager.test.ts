import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { SkillsManager } from '@tkottke90/skills-manager';
import { seedDefaultSkills } from './skills-manager.js';
import { DEFAULT_SKILLS } from './default-skills.js';

// Exercises the real DEFAULT_SKILLS data (not a local fixture) — this is
// specifically about whether the production seed values and the issue #409
// backfill logic behave correctly together, the same reasoning
// skill-gated-tools.middleware.test.ts's "production regression" blocks use
// for exercising real data instead of a stand-in.
describe('services/skills-manager — seedDefaultSkills', () => {
  let dir: string;
  let manager: SkillsManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skills-manager-test-'));
    manager = new SkillsManager(dir);
    await manager.boot();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('seeds every DEFAULT_SKILLS entry fresh, including their tools value [unit]', async () => {
    await seedDefaultSkills(manager);

    const createWorkspace = manager.list().find((s) => s.name === 'create-workspace');
    expect(createWorkspace?.tools).to.equal('create_workspace');

    // ingest-document is deliberately seeded with no tools value at all —
    // confirms the backfill loop's `if (!input.tools) continue` guard
    // doesn't somehow force one onto a skill that was never meant to have
    // one.
    const ingestDocument = manager.list().find((s) => s.name === 'ingest-document');
    expect(ingestDocument, 'ingest-document should still be seeded').to.not.equal(undefined);
    expect(ingestDocument?.tools).to.equal(undefined);
  });

  it('backfills tools onto a skill that was seeded before #409, with no tools and no migration marker [unit]', async () => {
    // Simulates an already-booted install: the skill exists exactly as it
    // would have before #409 added `tools` to DEFAULT_SKILLS.
    await manager.create({
      name: 'create-workspace',
      description: 'Create a new workspace conversationally, without leaving the chat.',
      body: 'pre-existing body',
    });

    await seedDefaultSkills(manager);

    const skill = await manager.load('create-workspace');
    expect(skill.frontmatter.tools).to.equal('create_workspace');
    expect(skill.frontmatter.metadata?.['tools-migrated-409']).to.equal('true');
    // The body a real install already has on disk is never touched by the
    // backfill — only tools/metadata change.
    expect(skill.body.trim()).to.equal('pre-existing body');
  });

  it('does not re-backfill once the migration marker is set, even if tools was since cleared [unit]', async () => {
    await manager.create({
      name: 'create-workspace',
      description: 'Create a new workspace conversationally, without leaving the chat.',
      body: 'pre-existing body',
      tools: 'create_workspace',
      metadata: { 'tools-migrated-409': 'true' },
    });
    // An admin deliberately clearing gating through the Settings UI, after
    // the migration already ran once.
    await manager.edit('create-workspace', { tools: '' });

    await seedDefaultSkills(manager);

    const skill = await manager.load('create-workspace');
    expect(skill.frontmatter.tools, 'a deliberate clear must never be re-overwritten').to.equal(
      '',
    );
  });

  it("never overwrites a skill's own existing, non-empty tools value [unit]", async () => {
    await manager.create({
      name: 'create-workspace',
      description: 'Create a new workspace conversationally, without leaving the chat.',
      body: 'pre-existing body',
      tools: 'create_workspace,extra_custom_tool',
    });

    await seedDefaultSkills(manager);

    const skill = await manager.load('create-workspace');
    expect(skill.frontmatter.tools).to.equal('create_workspace,extra_custom_tool');
  });

  it('is idempotent — running it twice seeds and backfills exactly once [unit]', async () => {
    await seedDefaultSkills(manager);
    await seedDefaultSkills(manager);

    const names = manager.list().map((s) => s.name);
    expect(names.filter((n) => n === 'create-workspace')).to.have.lengthOf(1);
    expect(names).to.have.lengthOf(DEFAULT_SKILLS.length);
  });
});
