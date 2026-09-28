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

    // Successful reads (status polls, list refreshes, static assets — this
    // middleware runs before express.static) are routine and would otherwise
    // bury real activity, so they log at debug. Writes and any error stay at
    // info. An aborted request keeps Express's default 200, so it's judged by
    // method alone — the long-lived GET /api/v1/events closing lands at debug.
    const quiet = (req.method === 'GET' || req.method === 'HEAD') && res.statusCode < 400;
    req.logger[quiet ? 'debug' : 'info'](
      `${req.method} ${req.originalUrl} [${durationMs.toFixed(2)} ms]`,
      {
        method: req.method,
        url: req.url,
        durationMs,
        status: res.statusCode,
      },
    );
  });

  next();
};
