import { Router } from 'express';
import { invalidateChatAgent } from '../../agents/chat-agent.js';
import { seedProviderCosts } from '../../services/usage.js';

export const settingsRouter = Router();

settingsRouter.post('/reload', (req, res) => {
  req.app.config.reload();
  invalidateChatAgent();
  seedProviderCosts();
  res.json({ status: 'ok' });
});
