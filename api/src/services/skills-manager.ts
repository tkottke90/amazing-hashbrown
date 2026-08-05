import { mkdir } from 'node:fs/promises';
import { SkillsManager } from '@tkottke90/skills-manager';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export const skillsManager = new SkillsManager(env.skillsRoot);

export async function bootSkillsManager(): Promise<void> {
  await mkdir(env.skillsRoot, { recursive: true });
  await skillsManager.boot();
  logger.info('SkillsManager booted', {
    skillsRoot: env.skillsRoot,
    skills: skillsManager.list().length,
  });
}
