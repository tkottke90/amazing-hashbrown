import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { logger } from './config/logger.js';
import { apiRouter } from './routes/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const httpLogger = logger.createChildLogger('http');

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use((req, res, next) => {
    httpLogger.info(`${req.method} ${req.path}`);
    next();
  });
  app.use('/api', apiRouter);
  app.use(express.static(publicDir));

  return app;
}
