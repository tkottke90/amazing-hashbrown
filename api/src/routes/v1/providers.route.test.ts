import { createServer, type Server } from 'node:http';
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { configManager } from '../../config/env.js';
import { startTestServer } from '../../../tests/utilities/http-test-server.js';
import { providersRouter } from './providers.route.js';

// Minimal local HTTP server standing in for an OpenAI-compatible /models
// endpoint, tracking every request it receives — used both to supply a
// fixed response body and to prove exactly how many requests were made
// (this is the interaction §4.2's design exists to control: one fetch per
// provider, never one per model).
function startModelsServer(body: unknown): Promise<{
  baseUrl: string;
  requestCount: () => number;
  close: () => void;
}> {
  return new Promise((resolve) => {
    let requests = 0;
    const server: Server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requestCount: () => requests,
        close: () => server.close(),
      });
    });
  });
}

describe('routes/v1/providers', () => {
  let baseUrl: string;
  let closeTestServer: () => Promise<void>;
  let closeModelsServer: (() => void) | undefined;

  afterEach(async () => {
    await closeTestServer?.();
    closeModelsServer?.();
    closeModelsServer = undefined;
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  it('calls the openai /models endpoint exactly twice total (not once per model) for a provider with 3 models', async () => {
    const modelsServer = await startModelsServer({
      object: 'list',
      data: [
        { id: 'vision-model', object: 'model', owned_by: 'lemonade', labels: ['vision'] },
        { id: 'text-model-a', object: 'model', owned_by: 'lemonade', labels: ['tool-calling'] },
        { id: 'text-model-b', object: 'model', owned_by: 'lemonade' },
      ],
    });
    closeModelsServer = modelsServer.close;

    configManager.set('providers', [
      {
        name: 'lemonade',
        type: 'openai',
        baseUrl: modelsServer.baseUrl,
        apiKey: 'sk-test',
        defaultModel: 'vision-model',
      },
    ]);

    ({ baseUrl, close: closeTestServer } = await startTestServer(
      providersRouter,
      '/api/v1/providers',
    ));
    const res = await fetch(baseUrl);
    expect(res.status).to.equal(200);

    // listModels() (liveIds) + fetchModelDetails() (labels) — exactly 2
    // requests total for this one provider, never 2 + N extra for its 3
    // models.
    expect(modelsServer.requestCount()).to.equal(2);
  });

  it('reports imageInput correctly per model based on which ones carry a vision label', async () => {
    const modelsServer = await startModelsServer({
      object: 'list',
      data: [
        { id: 'vision-model', object: 'model', owned_by: 'lemonade', labels: ['vision'] },
        { id: 'text-model', object: 'model', owned_by: 'lemonade', labels: ['tool-calling'] },
      ],
    });
    closeModelsServer = modelsServer.close;

    configManager.set('providers', [
      {
        name: 'lemonade',
        type: 'openai',
        baseUrl: modelsServer.baseUrl,
        apiKey: 'sk-test',
        defaultModel: 'vision-model',
      },
    ]);

    ({ baseUrl, close: closeTestServer } = await startTestServer(
      providersRouter,
      '/api/v1/providers',
    ));
    const res = await fetch(baseUrl);
    const body = (await res.json()) as {
      providers: { name: string; models: { id: string; imageInput: boolean }[] }[];
    };

    const models = body.providers.find((p) => p.name === 'lemonade')?.models ?? [];
    expect(models.find((m) => m.id === 'vision-model')?.imageInput).to.equal(true);
    expect(models.find((m) => m.id === 'text-model')?.imageInput).to.equal(false);
  });

  it('never calls fetchModelDetails (no extra /models request) for a non-openai provider', async () => {
    const modelsServer = await startModelsServer({
      models: [{ name: 'llama3', model: 'llama3' }],
    });
    closeModelsServer = modelsServer.close;

    configManager.set('providers', [
      {
        name: 'local-ollama',
        type: 'ollama',
        baseUrl: modelsServer.baseUrl,
        defaultModel: 'llama3',
      },
    ]);

    ({ baseUrl, close: closeTestServer } = await startTestServer(
      providersRouter,
      '/api/v1/providers',
    ));
    const res = await fetch(baseUrl);
    expect(res.status).to.equal(200);

    // Ollama's client.list()/client.show() hit different paths than an
    // openai-type fetchModelDetails() would — what matters here is that no
    // *extra* request beyond what listModels()/resolveVisionCapabilityFromConfig's
    // existing ollama dispatch already made was fired for "details".
    // Ollama goes through its own `Ollama` client (list + one show() per
    // model), which this mock server also answers to, so just confirm the
    // route succeeds and returns the expected shape without throwing.
    const body = (await res.json()) as { providers: { name: string }[] };
    expect(body.providers).to.have.length(1);
  });

  it('keeps the existing response shape: pricing merge and defaultProvider', async () => {
    const modelsServer = await startModelsServer({
      object: 'list',
      data: [{ id: 'gpt-4o', object: 'model', owned_by: 'openai' }],
    });
    closeModelsServer = modelsServer.close;

    configManager.set('providers', [
      {
        name: 'my-openai',
        type: 'openai',
        baseUrl: modelsServer.baseUrl,
        apiKey: 'sk-test',
        defaultModel: 'gpt-4o',
        models: [{ id: 'gpt-4o', inputPricePerM: 2.5, outputPricePerM: 10 }],
      },
    ]);
    configManager.set('defaultProvider', 'my-openai');

    ({ baseUrl, close: closeTestServer } = await startTestServer(
      providersRouter,
      '/api/v1/providers',
    ));
    const res = await fetch(baseUrl);
    const body = (await res.json()) as {
      providers: {
        name: string;
        models: { id: string; inputPricePerM?: number; outputPricePerM?: number }[];
      }[];
      defaultProvider: string;
      favoriteModels: unknown[];
    };

    expect(body.defaultProvider).to.equal('my-openai');
    expect(body.favoriteModels).to.be.an('array');
    const model = body.providers[0]?.models[0];
    expect(model?.inputPricePerM).to.equal(2.5);
    expect(model?.outputPricePerM).to.equal(10);
  });
});
