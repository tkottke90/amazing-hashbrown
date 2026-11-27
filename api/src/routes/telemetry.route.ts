import { Router } from 'express';
import type { Request, Response } from 'express';
import { scrapeTelemetryHandler } from './telemetry.handlers.js';

// The Telemetry Endpoint (see GLOSSARY.md). Mounted at the app root, not
// under /api: /metrics is Prometheus's default scrape path, and
// /api/v1/metrics is already the System Widget Metric catalog.
export const telemetryRouter = Router();

telemetryRouter.get('/', async (req: Request, res: Response) => {
  try {
    const result = await scrapeTelemetryHandler();
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.set('Content-Type', result.data.contentType).send(result.data.body);
  } catch (err) {
    req.logger.error('Telemetry scrape failed', { err });
    res.status(500).json({ error: 'Telemetry scrape failed' });
  }
});
