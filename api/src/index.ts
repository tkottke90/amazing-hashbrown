import { createApp } from './app.js';
import { bootToolsManager } from './services/tools-manager.js';

const app = createApp();

await bootToolsManager();

app.start();

process.on('exit', (code) => {
  app.logger.info(`Process exiting with code ${code}`);
});
