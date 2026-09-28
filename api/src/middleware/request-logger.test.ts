import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Router } from 'express';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { logger } from '../config/logger.js';
import { requestLogger } from './request-logger.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

// Replaces logger.createChildLogger with a factory whose child loggers only
// record which level each line was written at — the level is the behaviour
// under test, so nothing asserts on message wording. Always call restore().
function captureRequestLogLevels() {
  const target = logger as unknown as Record<string, unknown>;
  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'createChildLogger');
  const original = target.createChildLogger;
  const levels: Level[] = [];
  const record = (level: Level) => () => {
    levels.push(level);
  };
  target.createChildLogger = () => ({
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  });
  return {
    levels,
    restore: () => {
      if (hadOwn) target.createChildLogger = original;
      else delete target.createChildLogger;
    },
  };
}

// The request log line is written on the response's 'close' event, which can
// land a tick after fetch() has already resolved on the client side.
async function waitForLogLine(levels: Level[]): Promise<void> {
  for (let i = 0; i < 100 && levels.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('middleware/request-logger', () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  let capture: ReturnType<typeof captureRequestLogLevels>;

  before(async () => {
    const router = Router();
    router.use(requestLogger);
    router.get('/ok', (_req, res) => {
      res.json({ ok: true });
    });
    router.get('/missing', (_req, res) => {
      res.status(404).json({ error: 'not found' });
    });
    router.get('/broken', (_req, res) => {
      res.status(500).json({ error: 'boom' });
    });
    router.post('/ok', (_req, res) => {
      res.json({ ok: true });
    });
    server = await startTestServer(router, '/test');
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    capture = captureRequestLogLevels();
  });

  afterEach(() => {
    capture.restore();
  });

  it('logs a successful GET at debug, so status polls and asset loads stay out of default output [unit]', async () => {
    await fetch(`${server.baseUrl}/ok`);
    await waitForLogLine(capture.levels);
    expect(capture.levels).to.deep.equal(['debug']);
  });

  it('logs a successful POST at info, since writes are real activity worth seeing [unit]', async () => {
    await fetch(`${server.baseUrl}/ok`, { method: 'POST' });
    await waitForLogLine(capture.levels);
    expect(capture.levels).to.deep.equal(['info']);
  });

  it('logs a GET that 404s at info, so a failed read is never hidden at debug [unit]', async () => {
    await fetch(`${server.baseUrl}/missing`);
    await waitForLogLine(capture.levels);
    expect(capture.levels).to.deep.equal(['info']);
  });

  it('logs a GET that 500s at info, so a server error is never hidden at debug [unit]', async () => {
    await fetch(`${server.baseUrl}/broken`);
    await waitForLogLine(capture.levels);
    expect(capture.levels).to.deep.equal(['info']);
  });
});
