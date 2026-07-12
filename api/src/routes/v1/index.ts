import { Router } from 'express';
import { healthRouter } from './health.route.js';
import { chatRouter } from './chat.route.js';
import { artifactsRouter } from './artifacts.route.js';
import { settingsRouter } from './settings.route.js';

export const v1Router = Router();

v1Router.use('/health', healthRouter);
v1Router.use('/chat', chatRouter);
v1Router.use('/artifacts', artifactsRouter);
v1Router.use('/settings', settingsRouter);
