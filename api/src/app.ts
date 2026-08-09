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
  app.use(express.json());
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
