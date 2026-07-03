import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../config/logger.js';

const NS_PER_SEC = 1e9;
const NS_TO_MS = 1e6;

// A fresh child logger per request, so req.logger (and every log line it
// writes) automatically carries the request's id and route.
export const requestLogger: RequestHandler = (req, res, next) => {
  const reqId = randomUUID();
  const route = [req.method.toLowerCase(), req.path.replace(/\//g, '-')].join('-');
  const start = process.hrtime();

  req.logger = logger.createChildLogger(route, { reqId });

  // 'close' fires once the response is fully sent (or the connection drops),
  // so it captures the full request lifecycle even for aborted requests.
  res.on('close', () => {
    const diff = process.hrtime(start);
    const durationMs = (diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS;

    req.logger.info(`${req.method} ${req.originalUrl} [${durationMs.toFixed(2)} ms]`, {
      method: req.method,
      url: req.url,
      durationMs,
      status: res.statusCode,
    });
  });

  next();
};
