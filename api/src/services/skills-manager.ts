import { mkdir } from 'node:fs/promises';
import { SkillsManager } from '@tkottke90/skills-manager';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { DEFAULT_SKILLS } from './default-skills.js';

export const skillsManager = new SkillsManager(env.skillsRoot);

// Seeds the built-in chat skills (create-workspace, create-project, ...) if
// missing — checked individually, same idiom as wiki.ts's bootKnowledgeBase,
// so an existing install only missing one of them still picks it up. Also
// backfills `tools` onto an already-existing seeded skill (issue #409) —
// see the second loop's own comment for why that can't just be "if tools is
// empty, set it" on every boot.
//
// Takes an explicit manager (defaulting to the real singleton) purely for
// testability, same pattern as resolveWorkspaceSkills()'s deps.manager —
// skills-manager.test.ts exercises this against a temp-dir SkillsManager
// rather than the production skillsRoot.
export async function seedDefaultSkills(manager: SkillsManager = skillsManager): Promise<void> {
  const existingNames = new Set(manager.list().map((s) => s.name));
  for (const input of DEFAULT_SKILLS) {
    if (existingNames.has(input.name)) continue;
    await manager.create(input);
    logger.info('Default skill seeded', { skill: input.name });
  }

  // One-time backfill: an install that already had these 4 skills seeded
  // before #409 added `tools` to DEFAULT_SKILLS would otherwise silently
  // lose all of their built-in tool-gates the moment this ships, with no
  // error (seeding above only fires for a skill that doesn't exist yet).
  // Marked via the skill's own metadata (already used for the `enabled`
  // flag) rather than re-checked on every boot — a plain "if tools is
  // empty, backfill it" check would also silently undo an admin's later,
  // deliberate clearing of a skill's gating through the Settings UI. Once
  // backfilled, the marker persists independently of `tools` itself, so a
  // later clear is never re-applied.
  for (const input of DEFAULT_SKILLS) {
    if (!input.tools) continue;
    const existing = manager.list().find((s) => s.name === input.name);
    if (!existing || existing.tools) continue;
    const current = await manager.load(input.name);
    if (current.frontmatter.metadata?.['tools-migrated-409']) continue;
    await manager.edit(input.name, {
      tools: input.tools,
      metadata: { ...current.frontmatter.metadata, 'tools-migrated-409': 'true' },
    });
    logger.info('Backfilled tools frontmatter on existing skill', { skill: input.name });
  }
}

export async function bootSkillsManager(): Promise<void> {
  await mkdir(env.skillsRoot, { recursive: true });
  await skillsManager.boot();
  await seedDefaultSkills();
  logger.info('SkillsManager booted', {
    skillsRoot: env.skillsRoot,
    skills: skillsManager.list().length,
  });
}
