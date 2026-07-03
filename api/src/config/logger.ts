import { configureFromSchema } from '@tkottke90/logger';
import { env } from './env.js';

export const logger = configureFromSchema('amazing-hashbrown-api', {
  level: env.logLevel,
  console: { enabled: true },
});
