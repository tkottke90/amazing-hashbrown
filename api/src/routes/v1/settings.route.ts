import { Router } from 'express';
import { invalidateChatAgent } from '../../agents/chat-agent.js';
import { loadAgentInstructions } from '../../config/agent-instructions.js';
import { seedProviderCosts } from '../../services/usage.js';
import { reloadTrackerRegistry } from '../../services/tracker-registry.js';
import { getProviderQueue } from '../../services/provider-queue.js';
import { env } from '../../config/env.js';
import {
  reloadSettingsHandler,
  getSettingsSectionHandler,
  patchSettingsSectionHandler,
} from './settings.handlers.js';

export const settingsRouter = Router();

const refreshProviderQueueLimits = () => getProviderQueue().refreshLimits();

settingsRouter.post('/reload', async (req, res) => {
  const result = await reloadSettingsHandler(
    req.app.config,
    loadAgentInstructions,
    invalidateChatAgent,
    seedProviderCosts,
    reloadTrackerRegistry,
    refreshProviderQueueLimits,
  );
  res.json(result);
});

settingsRouter.get('/:slug', (req, res) => {
  const result = getSettingsSectionHandler(req.params.slug, env, req.app.config);
  res.status(result.ok ? 200 : result.status).json(result);
});

settingsRouter.patch('/:slug', async (req, res) => {
  const result = await patchSettingsSectionHandler(
    req.params.slug,
    req.body,
    req.app.config,
    env,
    loadAgentInstructions,
    invalidateChatAgent,
    seedProviderCosts,
    reloadTrackerRegistry,
    refreshProviderQueueLimits,
  );
  res.status(result.ok ? 200 : result.status).json(result);
});
