import type { Logger } from '@tkottke90/logger';

declare module 'express-serve-static-core' {
  interface Application {
    logger: Logger;
  }

  interface Request {
    logger: Logger;
  }
}
