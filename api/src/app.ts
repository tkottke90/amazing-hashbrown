import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { apiRouter } from './routes/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use(express.static(publicDir));

  return app;
}
