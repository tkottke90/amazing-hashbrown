import type { RequestHandler } from 'express';
import { getApiKeyStore } from '../services/api-key-store.js';

const BEARER_PREFIX = /^Bearer (.+)$/;

// Mounted only on POST /api/v1/webhooks/tasks. Never distinguishes "key
// doesn't exist" from "key is malformed" in its response, to avoid leaking
// which case applies — see the design spec's error-handling section
// (docs/superpowers/specs/2026-10-02-webhook-task-creation-design.md).
export const apiKeyAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? BEARER_PREFIX.exec(header) : null;
  if (!match || !getApiKeyStore().verify(match[1] as string)) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  next();
};
