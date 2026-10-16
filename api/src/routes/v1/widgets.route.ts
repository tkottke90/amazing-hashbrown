import { Router } from 'express';
import type { Request, Response } from 'express';
import { validateWidgetHandler } from './widgets.handlers.js';

export const widgetsRouter = Router();

// Flat, not nested under /dashboards/:dashboardId/widgets/:id — this
// validates submitted text, not a stored resource (see the handler's doc
// comment).
widgetsRouter.post('/validate', (req: Request, res: Response) => {
  const result = validateWidgetHandler(req.body);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
