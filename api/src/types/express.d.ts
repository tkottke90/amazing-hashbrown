import type { ConfigManager } from '@tkottke90/config-manager';
import type { Logger } from '@tkottke90/logger';

declare module 'express-serve-static-core' {
  interface Application {
    logger: Logger;
    config: ConfigManager;
  }

  interface Request {
    logger: Logger;
  }
}
