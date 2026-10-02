import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

// Guards POST /api/v1/webhooks/tasks against brute-force/DoS — that
// endpoint may be exposed to the public internet, unlike the rest of this
// app's currently-unauthenticated routes. Default keyGenerator is
// IP-based, which is exactly the "per-IP" scope the design calls for.
//
// Reads env.webhookRateLimitPerMinute once, at module load (router
// construction) — a later configManager.reload() won't change the
// threshold without a restart. Acceptable: this isn't a hot-reloaded
// setting.
export const webhookRateLimit = rateLimit({
  windowMs: 60_000,
  limit: env.webhookRateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many requests' });
  },
});
