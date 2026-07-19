import { Router } from 'express';
import { healthRouter } from './health.route.js';
import { chatRouter } from './chat.route.js';
import { artifactsRouter } from './artifacts.route.js';
import { settingsRouter } from './settings.route.js';
import { providersRouter } from './providers.route.js';
import { tracesRouter } from './traces.route.js';
import { usageRouter } from './usage.route.js';
import { threadsRouter } from './threads.route.js';

export const v1Router = Router();

v1Router.use('/health', healthRouter);
v1Router.use('/chat', chatRouter);
v1Router.use('/artifacts', artifactsRouter);
v1Router.use('/settings', settingsRouter);
v1Router.use('/providers', providersRouter);
v1Router.use('/traces', tracesRouter);
v1Router.use('/usage', usageRouter);
v1Router.use('/threads', threadsRouter);
