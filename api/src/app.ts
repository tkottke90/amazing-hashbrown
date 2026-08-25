import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { configManager } from './config/env.js';
import { logger } from './config/logger.js';
import { requestLogger } from './middleware/request-logger.js';
import { apiRouter } from './routes/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

export function createApp() {
  const app = express();
  app.logger = logger;
  app.config = configManager;

  app.use(cors());
  // Default body-parser limit is ~100kb — well under the 2MB application-
  // level file-content guard (workspace-files.ts), which would silently
  // break saving any file over 100kb with a 413 before it ever reached that
  // guard. 5mb gives headroom over the 2MB cap for JSON-string-escaping
  // overhead; that 2MB guard is what actually enforces the business rule.
  app.use(express.json({ limit: '5mb' }));
  app.use(requestLogger);
  app.use('/api', apiRouter);
  app.use(express.static(publicDir));

  // Serve index.html for all other routes (for SPA support)
  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.start = () => {
    const port = app.config.getNumber('port', 3000) as number;
    const host = app.config.get('host', '0.0.0.0') as string;

    app.listen(port, host, () => {
      logger.info(`API listening on port ${host}:${port}`);
    });
  };

  return app;
}
