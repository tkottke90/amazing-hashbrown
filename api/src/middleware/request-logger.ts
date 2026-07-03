import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../config/logger.js';

// A fresh child logger per request, so req.logger (and every log line it
// writes) automatically carries the request's id and route.
export const requestLogger: RequestHandler = (req, res, next) => {
  const reqId = randomUUID();
  const route = [req.method.toLowerCase(), req.path.replace(/\//g, '-')].join('-');
  const start = Date.now();

  req.logger = logger.createChildLogger(route, { reqId });

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    req.logger.info(`${req.method} ${req.path} ${res.statusCode}`, { durationMs });
  });

  next();
};
