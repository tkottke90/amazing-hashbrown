import type { Logger } from '@tkottke90/logger';
import type { AppConfig } from '../config/env.js';

declare module 'express-serve-static-core' {
  interface Application {
    logger: Logger;
    config: AppConfig;
  }

  interface Request {
    logger: Logger;
  }
}
