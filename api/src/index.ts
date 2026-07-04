import { createApp } from './app.js';

const app = createApp();

app.start();

process.on('exit', (code) => {
  app.logger.info(`Process exiting with code ${code}`);
});