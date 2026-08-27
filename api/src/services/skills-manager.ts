import { mkdir } from 'node:fs/promises';
import { SkillsManager } from '@tkottke90/skills-manager';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { DEFAULT_SKILLS } from './default-skills.js';

export const skillsManager = new SkillsManager(env.skillsRoot);

// Seeds the built-in chat skills (create-workspace, create-project, ...) if
// missing — checked individually, same idiom as wiki.ts's bootKnowledgeBase,
// so an existing install only missing one of them still picks it up.
async function seedDefaultSkills(): Promise<void> {
  const existingNames = new Set(skillsManager.list().map((s) => s.name));
  for (const input of DEFAULT_SKILLS) {
    if (existingNames.has(input.name)) continue;
    await skillsManager.create(input);
    logger.info('Default skill seeded', { skill: input.name });
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
