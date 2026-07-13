import { Router } from 'express';
import { invalidateChatAgent } from '../../agents/chat-agent.js';

export const settingsRouter = Router();

settingsRouter.post('/reload', (req, res) => {
  req.app.config.reload();
  invalidateChatAgent();
  res.json({ status: 'ok' });
});
