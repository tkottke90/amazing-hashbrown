import { Router } from 'express';
import { healthRouter } from './health.route.js';
import { chatRouter } from './chat.route.js';

export const v1Router = Router();

v1Router.use('/health', healthRouter);
v1Router.use('/chat', chatRouter);
