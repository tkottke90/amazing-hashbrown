import { Router } from 'express';
import { invalidateChatAgent } from '../../agents/chat-agent.js';
import { loadAgentInstructions } from '../../config/agent-instructions.js';
import { seedProviderCosts } from '../../services/usage.js';
import { reloadSettingsHandler } from './settings.handlers.js';

export const settingsRouter = Router();

settingsRouter.post('/reload', async (req, res) => {
  const result = await reloadSettingsHandler(
    req.app.config,
    loadAgentInstructions,
    invalidateChatAgent,
    seedProviderCosts,
  );
  res.json(result);
});
