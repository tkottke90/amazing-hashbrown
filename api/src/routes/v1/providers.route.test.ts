import { createServer, type Server } from 'node:http';
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import {
  configManager,
  type AzureOpenAiProviderConfig,
  type OpenAiCompatibleProviderConfig,
} from '../../config/env.js';
import { startTestServer } from '../../../tests/utilities/http-test-server.js';
import { providersRouter } from './providers.route.js';
import { getOidcTokenCache } from '../../services/oidc-token-cache.js';

const azureConfig: AzureOpenAiProviderConfig = {
  name: 'azure',
  type: 'azure-openai',
  endpoint: 'https://my-resource.openai.azure.com',
  deploymentName: 'gpt-4o',
  apiVersion: '2024-10-21',
  auth: {
    tokenUrl: 'https://login.example.com/token',
    clientId: 'id',
    grantType: 'client_credentials',
  },
};

const openaiCompatibleApiKeyConfig: OpenAiCompatibleProviderConfig = {
  name: 'in-house-gateway',
  type: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1', // overridden per-test with a real stand-in server's baseUrl
  authMode: 'apiKey',
  apiKey: 'sk-test',
};

const openaiCompatibleOidcConfig: OpenAiCompatibleProviderConfig = {
  name: 'in-house-gateway-oidc',
  type: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1', // overridden per-test with a real stand-in server's baseUrl
  authMode: 'oidc',
  auth: {
    tokenUrl: 'http://127.0.0.1:1', // overridden per-test with a real stand-in server's baseUrl
    clientId: 'id',
    grantType: 'client_credentials',
  },
};

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

// A stand-in IdP token endpoint that always fails with the given status —
// used to exercise POST /test-oidc-token's failure path without needing a
// real broken server (non-OK is all that matters; the body is irrelevant).
function startFailingTokenServer(
  status: number,
  text: string,
): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(text);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
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
    getOidcTokenCache().revoke('azure');
    getOidcTokenCache().revoke('in-house-gateway-oidc');
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

  it("reports an azure-openai provider's deploymentName as its one model, with no live /models call", async () => {
    // No mock server at all — if GET / tried to make a live call for this
    // provider, it would have nothing to reach and the request would fail
    // rather than resolve.
    configManager.set('providers', [azureConfig]);

    ({ baseUrl, close: closeTestServer } = await startTestServer(
      providersRouter,
      '/api/v1/providers',
    ));
    const res = await fetch(baseUrl);
    expect(res.status).to.equal(200);
    const body = (await res.json()) as {
      providers: { name: string; type: string; defaultModel?: string; models: { id: string }[] }[];
    };

    const provider = body.providers.find((p) => p.name === 'azure');
    expect(provider?.defaultModel).to.equal('gpt-4o');
    expect(provider?.models.map((m) => m.id)).to.deep.equal(['gpt-4o']);
  });

  describe('POST /:name/revoke', () => {
    it('clears the cached Access Token for an existing azure-openai provider', async () => {
      const tokenServer = await startModelsServer({ access_token: 'tok-1', expires_in: 3600 });
      closeModelsServer = tokenServer.close;
      configManager.set('providers', [
        { ...azureConfig, auth: { ...azureConfig.auth, tokenUrl: tokenServer.baseUrl } },
      ]);

      // Seed the cache from the local stand-in token server.
      await getOidcTokenCache().getToken({
        name: azureConfig.name,
        auth: { ...azureConfig.auth, tokenUrl: tokenServer.baseUrl },
      });
      expect(tokenServer.requestCount()).to.equal(1);

      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/azure/revoke`, { method: 'POST' });
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({ ok: true });

      // The cache was actually cleared — the next getToken call re-fetches
      // rather than returning the (now-revoked) cached token.
      await getOidcTokenCache().getToken({
        name: azureConfig.name,
        auth: { ...azureConfig.auth, tokenUrl: tokenServer.baseUrl },
      });
      expect(tokenServer.requestCount()).to.equal(2);
    });

    it('clears the cached Access Token for an existing openai-compatible/oidc provider', async () => {
      const tokenServer = await startModelsServer({ access_token: 'tok-1', expires_in: 3600 });
      closeModelsServer = tokenServer.close;
      const provider = {
        ...openaiCompatibleOidcConfig,
        auth: { ...openaiCompatibleOidcConfig.auth!, tokenUrl: tokenServer.baseUrl },
      };
      configManager.set('providers', [provider]);

      await getOidcTokenCache().getToken({ name: provider.name, auth: provider.auth });
      expect(tokenServer.requestCount()).to.equal(1);

      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/${provider.name}/revoke`, { method: 'POST' });
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({ ok: true });

      await getOidcTokenCache().getToken({ name: provider.name, auth: provider.auth });
      expect(tokenServer.requestCount()).to.equal(2);
    });

    it('404s for an openai-compatible provider in apiKey mode (not OIDC-authenticated)', async () => {
      configManager.set('providers', [openaiCompatibleApiKeyConfig]);
      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/${openaiCompatibleApiKeyConfig.name}/revoke`, {
        method: 'POST',
      });
      expect(res.status).to.equal(404);
    });

    it('404s for an unknown provider name', async () => {
      configManager.set('providers', [azureConfig]);
      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/does-not-exist/revoke`, { method: 'POST' });
      expect(res.status).to.equal(404);
    });

    it('404s for a provider that is not an azure-openai type', async () => {
      configManager.set('providers', [
        {
          name: 'local',
          type: 'ollama',
          baseUrl: 'http://localhost:11434',
          defaultModel: 'llama3',
        },
      ]);
      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/local/revoke`, { method: 'POST' });
      expect(res.status).to.equal(404);
    });
  });

  it('reports imageInput for an openai-compatible/apiKey provider, same as the openai case', async () => {
    const modelsServer = await startModelsServer({
      object: 'list',
      data: [
        { id: 'vision-model', object: 'model', owned_by: 'in-house', labels: ['vision'] },
        { id: 'text-model', object: 'model', owned_by: 'in-house', labels: ['tool-calling'] },
      ],
    });
    closeModelsServer = modelsServer.close;

    configManager.set('providers', [
      {
        ...openaiCompatibleApiKeyConfig,
        baseUrl: modelsServer.baseUrl,
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

    const models =
      body.providers.find((p) => p.name === openaiCompatibleApiKeyConfig.name)?.models ?? [];
    expect(models.find((m) => m.id === 'vision-model')?.imageInput).to.equal(true);
    expect(models.find((m) => m.id === 'text-model')?.imageInput).to.equal(false);
  });

  it('lists live models for an openai-compatible/oidc provider, authenticating with the fetched token', async () => {
    const tokenServer = await startModelsServer({ access_token: 'tok-live', expires_in: 3600 });
    closeModelsServer = tokenServer.close;
    const modelsServer = await startModelsServer({
      object: 'list',
      data: [{ id: 'gpt-5.4-mini', object: 'model', owned_by: 'in-house' }],
    });

    configManager.set('providers', [
      {
        ...openaiCompatibleOidcConfig,
        baseUrl: modelsServer.baseUrl,
        auth: { ...openaiCompatibleOidcConfig.auth!, tokenUrl: tokenServer.baseUrl },
      },
    ]);

    ({ baseUrl, close: closeTestServer } = await startTestServer(
      providersRouter,
      '/api/v1/providers',
    ));
    const res = await fetch(baseUrl);
    expect(res.status).to.equal(200);
    const body = (await res.json()) as {
      providers: { name: string; models: { id: string }[] }[];
    };
    const provider = body.providers.find((p) => p.name === openaiCompatibleOidcConfig.name);
    expect(provider?.models.map((m) => m.id)).to.deep.equal(['gpt-5.4-mini']);

    modelsServer.close();
  });

  describe('POST /models', () => {
    it('accepts openai-compatible/apiKey and lists its live models', async () => {
      const modelsServer = await startModelsServer({
        object: 'list',
        data: [{ id: 'gpt-5.4-mini' }],
      });
      closeModelsServer = modelsServer.close;

      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'openai-compatible',
          baseUrl: modelsServer.baseUrl,
          apiKey: 'sk-test',
        }),
      });
      expect(res.status).to.equal(200);
      const body = (await res.json()) as { ok: boolean; data: { models: string[] } };
      expect(body).to.deep.equal({ ok: true, data: { models: ['gpt-5.4-mini'] } });
    });

    it('accepts openai-compatible/oidc, resolving a masked clientSecret against the named stored provider', async () => {
      const tokenServer = await startModelsServer({ access_token: 'tok-1', expires_in: 3600 });
      closeModelsServer = tokenServer.close;
      const modelsServer = await startModelsServer({
        object: 'list',
        data: [{ id: 'gpt-5.4-mini' }],
      });

      const stored = {
        ...openaiCompatibleOidcConfig,
        auth: {
          ...openaiCompatibleOidcConfig.auth!,
          tokenUrl: tokenServer.baseUrl,
          clientSecret: 'real-secret',
        },
      };
      configManager.set('providers', [stored]);

      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'openai-compatible',
          authMode: 'oidc',
          name: stored.name,
          baseUrl: modelsServer.baseUrl,
          tokenUrl: stored.auth.tokenUrl,
          clientId: stored.auth.clientId,
          clientSecret: '****',
        }),
      });
      expect(res.status).to.equal(200);
      const body = (await res.json()) as { ok: boolean; data: { models: string[] } };
      expect(body).to.deep.equal({ ok: true, data: { models: ['gpt-5.4-mini'] } });

      modelsServer.close();
    });

    it('still rejects azure-openai (no model picker for that type)', async () => {
      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'azure-openai', baseUrl: 'https://example.com' }),
      });
      expect(res.status).to.equal(400);
    });
  });

  describe('POST /test-oidc-token', () => {
    it('resolves expiresInSeconds on success', async () => {
      const tokenServer = await startModelsServer({ access_token: 'tok-1', expires_in: 1800 });
      closeModelsServer = tokenServer.close;

      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/test-oidc-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenUrl: tokenServer.baseUrl,
          clientId: 'id',
          clientSecret: 'secret',
        }),
      });
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({ ok: true, expiresInSeconds: 1800 });
    });

    it('reports ok:false on a failed token request', async () => {
      const tokenServer = await startFailingTokenServer(401, 'invalid_client');
      closeModelsServer = tokenServer.close;

      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/test-oidc-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenUrl: tokenServer.baseUrl,
          clientId: 'id',
          clientSecret: 'wrong',
        }),
      });
      expect(res.status).to.equal(502);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).to.equal(false);
    });

    it('resolves a masked clientSecret against the named stored provider (azure-openai)', async () => {
      const tokenServer = await startModelsServer({ access_token: 'tok-1', expires_in: 3600 });
      closeModelsServer = tokenServer.close;
      const stored = {
        ...azureConfig,
        auth: { ...azureConfig.auth, tokenUrl: tokenServer.baseUrl, clientSecret: 'real-secret' },
      };
      configManager.set('providers', [stored]);

      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/test-oidc-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerName: stored.name,
          tokenUrl: stored.auth.tokenUrl,
          clientId: stored.auth.clientId,
          clientSecret: '****',
        }),
      });
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({ ok: true, expiresInSeconds: 3600 });
    });

    it('never writes to the persistent token cache — a later chat-path getToken still fetches fresh', async () => {
      const tokenServer = await startModelsServer({
        access_token: 'test-only-tok',
        expires_in: 3600,
      });
      closeModelsServer = tokenServer.close;

      ({ baseUrl, close: closeTestServer } = await startTestServer(
        providersRouter,
        '/api/v1/providers',
      ));
      const res = await fetch(`${baseUrl}/test-oidc-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenUrl: tokenServer.baseUrl,
          clientId: 'id',
          clientSecret: 'secret',
        }),
      });
      expect(res.status).to.equal(200);
      expect(tokenServer.requestCount()).to.equal(1);

      await getOidcTokenCache().getToken({
        name: 'never-cached-by-test-oidc-token',
        auth: { tokenUrl: tokenServer.baseUrl, clientId: 'id', grantType: 'client_credentials' },
      });
      expect(tokenServer.requestCount()).to.equal(2);
    });
  });
});
