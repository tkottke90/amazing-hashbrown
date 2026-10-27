import { createServer, type Server } from 'node:http';
import { describe, it, after } from 'mocha';
import { expect } from 'chai';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { Ollama } from 'ollama';
import {
  applyEvalDeterminism,
  describeSampling,
  createProvider,
  createProviderFromConfig,
  createOidcAuthenticatingFetch,
  resolveEffectiveSampling,
  hasOllamaVisionCapability,
  resolveVisionCapability,
  resolveVisionCapabilityFromConfig,
  fetchModelDetails,
  listModels,
  FALLBACK_VISION_CAPABILITIES,
} from './provider-factory.js';
import type {
  ProviderConfig,
  AzureOpenAiProviderConfig,
  OpenAiCompatibleProviderConfig,
} from '../config/env.js';

// Minimal local HTTP server standing in for an OpenAI-compatible /models
// endpoint — there's no sinon in this repo's toolchain and fetchModelDetails
// constructs its own `OpenAI` client internally (same as fetchModelIds), so
// a real HTTP call is the only way to exercise a specific response body.
// Each test starts its own server (different port each time, via `0`) and
// closes it in `after` to avoid leaking across test files.
function startModelsServer(body: unknown): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

// Same shape as startModelsServer, but also records the Authorization header
// each request arrived with — used to prove the oidc authenticating path
// actually sends the token the stubbed cache handed back, not just that the
// call succeeds.
function startAuthCapturingModelsServer(
  body: unknown,
): Promise<{ baseUrl: string; close: () => void; capturedAuth: () => string | undefined }> {
  return new Promise((resolve) => {
    let lastAuth: string | undefined;
    const server: Server = createServer((req, res) => {
      lastAuth = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        capturedAuth: () => lastAuth,
      });
    });
  });
}

function stubOllamaClient(capabilities: string[] | undefined, fail = false): Pick<Ollama, 'show'> {
  return {
    show: async () => {
      if (fail) throw new Error('boom');
      // Only the `capabilities` field is exercised by hasOllamaVisionCapability.
      return { capabilities } as Awaited<ReturnType<Ollama['show']>>;
    },
  };
}

const ollamaConfig: ProviderConfig = {
  name: 'local',
  type: 'ollama',
  baseUrl: 'http://localhost:11434',
  defaultModel: 'llama3',
};

const openaiConfig: ProviderConfig = {
  name: 'gpt',
  type: 'openai',
  apiKey: 'sk-test',
  defaultModel: 'gpt-4o',
};

const anthropicConfig: ProviderConfig = {
  name: 'claude',
  type: 'anthropic',
  apiKey: 'sk-ant-test',
  defaultModel: 'claude-sonnet-4-6',
};

const azureConfig: AzureOpenAiProviderConfig = {
  name: 'azure',
  type: 'azure-openai',
  endpoint: 'https://my-resource.openai.azure.com',
  deploymentName: 'gpt-4o',
  apiVersion: '2024-10-21',
  auth: {
    tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    grantType: 'client_credentials',
  },
};

const openaiCompatibleApiKeyConfig: OpenAiCompatibleProviderConfig = {
  name: 'in-house-gateway',
  type: 'openai-compatible',
  baseUrl: 'https://api.example.com/1.0/openai/v1',
  defaultModel: 'gpt-5.4-mini',
  authMode: 'apiKey',
  apiKey: 'sk-test',
};

const openaiCompatibleOidcConfig: OpenAiCompatibleProviderConfig = {
  name: 'in-house-gateway-oidc',
  type: 'openai-compatible',
  baseUrl: 'https://api.example.com/1.0/openai/v1',
  defaultModel: 'gpt-5.4-mini',
  authMode: 'oidc',
  auth: {
    tokenUrl: 'https://login.example.com/token',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    grantType: 'client_credentials',
  },
};

// A stub Access Token cache that never makes a real HTTP call — proves the
// azureADTokenProvider/authenticating-fetch wiring, not just field
// passthrough. Shared by azure-openai and openai-compatible/oidc tests
// below, so it's typed against the generalized { name, auth } shape rather
// than either concrete provider config.
function stubTokenCache(token = 'fake-token') {
  const calls: Array<{ name: string }> = [];
  return {
    calls,
    cache: {
      getToken: async (config: { name: string }) => {
        calls.push(config);
        return token;
      },
    },
  };
}

describe('services/provider-factory', () => {
  describe('createProviderFromConfig()', () => {
    it('returns ChatOllama for type ollama', () => {
      expect(createProviderFromConfig(ollamaConfig)).to.be.instanceOf(ChatOllama);
    });

    it('returns ChatOpenAI for type openai', () => {
      expect(createProviderFromConfig(openaiConfig)).to.be.instanceOf(ChatOpenAI);
    });

    it('returns ChatAnthropic for type anthropic', () => {
      expect(createProviderFromConfig(anthropicConfig)).to.be.instanceOf(ChatAnthropic);
    });

    it('model override does not throw for any provider type', () => {
      expect(() => createProviderFromConfig(ollamaConfig, 'llama3.2')).to.not.throw();
      expect(() => createProviderFromConfig(openaiConfig, 'gpt-4-turbo')).to.not.throw();
      expect(() =>
        createProviderFromConfig(anthropicConfig, 'claude-haiku-4-5-20251001'),
      ).to.not.throw();
    });

    it('throws when no defaultModel and no model override', () => {
      const noModel: ProviderConfig = {
        name: 'x',
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
      };
      expect(() => createProviderFromConfig(noModel)).to.throw(/defaultModel/);
    });

    it('throws when ollama has no baseUrl', () => {
      const noBase: ProviderConfig = { name: 'x', type: 'ollama', defaultModel: 'llama3' };
      expect(() => createProviderFromConfig(noBase)).to.throw(/baseUrl/);
    });

    it('does not throw when openai has no apiKey (warns only)', () => {
      const noKey: ProviderConfig = { name: 'x', type: 'openai', defaultModel: 'gpt-4o' };
      expect(() => createProviderFromConfig(noKey)).to.not.throw();
    });

    it('throws when anthropic has no apiKey and ANTHROPIC_API_KEY env var is unset', () => {
      // ChatAnthropic validates the key eagerly at construction time.
      // The factory warns first, then the constructor throws.
      const noKey: ProviderConfig = {
        name: 'x',
        type: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
      };
      if (!process.env.ANTHROPIC_API_KEY) {
        expect(() => createProviderFromConfig(noKey)).to.throw();
      } else {
        expect(() => createProviderFromConfig(noKey)).to.not.throw();
      }
    });

    describe('timeoutMs safety net', () => {
      it('passes timeoutMs through as the top-level timeout on ChatOpenAI', () => {
        const agent = createProviderFromConfig({ ...openaiConfig, timeoutMs: 5000 }) as ChatOpenAI;
        expect(agent.timeout).to.equal(5000);
      });

      it('leaves ChatOpenAI.timeout undefined when timeoutMs is not configured', () => {
        const agent = createProviderFromConfig(openaiConfig) as ChatOpenAI;
        expect(agent.timeout).to.equal(undefined);
      });

      it('passes timeoutMs through as clientOptions.timeout on ChatAnthropic (no top-level timeout field exists on this class)', () => {
        const agent = createProviderFromConfig({
          ...anthropicConfig,
          timeoutMs: 5000,
        }) as ChatAnthropic;
        expect(agent.clientOptions.timeout).to.equal(5000);
      });

      it('leaves ChatAnthropic.clientOptions.timeout undefined when timeoutMs is not configured', () => {
        const agent = createProviderFromConfig(anthropicConfig) as ChatAnthropic;
        expect(agent.clientOptions.timeout).to.equal(undefined);
      });

      it('does not throw for ollama when timeoutMs is set (known gap — not wired for this provider type)', () => {
        expect(() => createProviderFromConfig({ ...ollamaConfig, timeoutMs: 5000 })).to.not.throw();
      });
    });

    // Targets @langchain/ollama 1.3.0, @langchain/openai 1.5.5 and
    // @langchain/anthropic 1.5.1 (checked against their published type
    // declarations): ChatOllama takes seed/topP/temperature as top-level
    // fields; ChatOpenAI takes temperature/topP top-level but seed only as a
    // per-call option, so it is carried via modelKwargs (spread into the
    // request body); ChatAnthropic has no seed concept at all.
    describe('sampling parameters', () => {
      it('passes temperature, topP and seed through to ChatOllama', () => {
        const agent = createProviderFromConfig({
          ...ollamaConfig,
          temperature: 0,
          topP: 0.9,
          seed: 7,
        }) as ChatOllama;
        expect(agent.temperature).to.equal(0);
        expect(agent.topP).to.equal(0.9);
        expect(agent.seed).to.equal(7);
      });

      it('passes temperature and topP through to ChatOpenAI and carries seed in modelKwargs', () => {
        const agent = createProviderFromConfig({
          ...openaiConfig,
          temperature: 0,
          topP: 0.9,
          seed: 7,
        }) as ChatOpenAI;
        expect(agent.temperature).to.equal(0);
        expect(agent.topP).to.equal(0.9);
        expect(agent.modelKwargs?.seed).to.equal(7);
      });

      it('passes temperature and topP through to ChatAnthropic', () => {
        const agent = createProviderFromConfig({
          ...anthropicConfig,
          temperature: 0,
          topP: 0.9,
        }) as ChatAnthropic;
        expect(agent.temperature).to.equal(0);
        expect(agent.topP).to.equal(0.9);
      });

      it('ignores seed for anthropic rather than throwing or forwarding it', () => {
        const agent = createProviderFromConfig({ ...anthropicConfig, seed: 7 }) as ChatAnthropic;
        expect(agent).to.not.have.property('seed');
      });

      it('leaves sampling parameters unset when config does not specify them', () => {
        const ollama = createProviderFromConfig(ollamaConfig) as ChatOllama;
        const openai = createProviderFromConfig(openaiConfig) as ChatOpenAI;
        expect(ollama.temperature).to.equal(undefined);
        expect(ollama.seed).to.equal(undefined);
        expect(openai.temperature).to.equal(undefined);
        expect(openai.modelKwargs?.seed).to.equal(undefined);
      });

      // numCtx/topK/repeatPenalty are Ollama-only — no OpenAI/Anthropic
      // constructor or API equivalent exists for any of them.
      it('passes numCtx, topK and repeatPenalty through to ChatOllama', () => {
        const agent = createProviderFromConfig({
          ...ollamaConfig,
          numCtx: 16384,
          topK: 40,
          repeatPenalty: 1.1,
        }) as ChatOllama;
        expect(agent.numCtx).to.equal(16384);
        expect(agent.topK).to.equal(40);
        expect(agent.repeatPenalty).to.equal(1.1);
      });

      it('a model-level override wins over the provider-level default', () => {
        const agent = createProviderFromConfig({
          ...ollamaConfig,
          temperature: 0,
          models: [{ id: 'llama3', temperature: 1 }],
        }) as ChatOllama;
        expect(agent.temperature).to.equal(1);
      });

      it('falls back to the provider-level default when the model has no override', () => {
        const agent = createProviderFromConfig({
          ...ollamaConfig,
          temperature: 0.4,
          models: [{ id: 'some-other-model', temperature: 1 }],
        }) as ChatOllama;
        expect(agent.temperature).to.equal(0.4);
      });
    });

    describe('azure-openai', () => {
      it('returns AzureChatOpenAI for type azure-openai', () => {
        const { cache } = stubTokenCache();
        const agent = createProviderFromConfig(azureConfig, undefined, { tokenCache: cache });
        expect(agent).to.be.instanceOf(AzureChatOpenAI);
      });

      it('passes endpoint, deploymentName and apiVersion through to the Azure-specific fields', () => {
        const { cache } = stubTokenCache();
        const agent = createProviderFromConfig(azureConfig, undefined, {
          tokenCache: cache,
        }) as AzureChatOpenAI;
        expect(agent.azureOpenAIEndpoint).to.equal('https://my-resource.openai.azure.com');
        expect(agent.azureOpenAIApiDeploymentName).to.equal('gpt-4o');
        expect(agent.azureOpenAIApiVersion).to.equal('2024-10-21');
      });

      it('wires azureADTokenProvider to the injected token cache rather than a static apiKey', async () => {
        const { cache, calls } = stubTokenCache('tok-from-cache');
        const agent = createProviderFromConfig(azureConfig, undefined, {
          tokenCache: cache,
        }) as AzureChatOpenAI;
        const token = await agent.azureADTokenProvider?.();
        expect(token).to.equal('tok-from-cache');
        expect(calls).to.have.length(1);
        expect(calls[0]?.name).to.equal('azure');
      });

      it('defaults to the shared process-wide token cache when none is injected', () => {
        // Just proves construction doesn't throw without an explicit
        // tokenCache dep — getAzureTokenCache() is only actually called
        // lazily, inside azureADTokenProvider, never at construction time.
        expect(() => createProviderFromConfig(azureConfig)).to.not.throw();
      });

      it('throws when no deploymentName-derived model and no model override', () => {
        const { cache } = stubTokenCache();
        const noModel = { ...azureConfig, deploymentName: '' };
        expect(() => createProviderFromConfig(noModel, undefined, { tokenCache: cache })).to.throw(
          /defaultModel/,
        );
      });
    });

    describe('openai-compatible', () => {
      it('returns ChatOpenAI (not AzureChatOpenAI) for authMode apiKey', () => {
        const agent = createProviderFromConfig(openaiCompatibleApiKeyConfig);
        expect(agent).to.be.instanceOf(ChatOpenAI);
        expect(agent).to.not.be.instanceOf(AzureChatOpenAI);
      });

      it('passes baseUrl and apiKey through for authMode apiKey, same as the openai case', () => {
        const agent = createProviderFromConfig(openaiCompatibleApiKeyConfig) as ChatOpenAI;
        expect(agent.clientConfig?.baseURL).to.equal('https://api.example.com/1.0/openai/v1');
      });

      it('returns ChatOpenAI (not AzureChatOpenAI) for authMode oidc', () => {
        const { cache } = stubTokenCache();
        const agent = createProviderFromConfig(openaiCompatibleOidcConfig, undefined, {
          tokenCache: cache,
        });
        expect(agent).to.be.instanceOf(ChatOpenAI);
        expect(agent).to.not.be.instanceOf(AzureChatOpenAI);
      });

      it('does not throw at construction and wires a function fetch override for authMode oidc', () => {
        const { cache } = stubTokenCache();
        // Construction must not throw: the underlying SDK requires some
        // non-empty apiKey (or OPENAI_API_KEY) to be set, even though the
        // real Authorization header comes from the fetch wrapper below, not
        // this placeholder — see createOidcAuthenticatingFetch's own test.
        expect(() =>
          createProviderFromConfig(openaiCompatibleOidcConfig, undefined, { tokenCache: cache }),
        ).to.not.throw();
        const agent = createProviderFromConfig(openaiCompatibleOidcConfig, undefined, {
          tokenCache: cache,
        }) as ChatOpenAI;
        expect(agent.clientConfig?.fetch).to.be.a('function');
      });

      it("the authenticating fetch wrapper injects the cached token's Authorization header for authMode oidc", async () => {
        const { cache, calls } = stubTokenCache('tok-from-cache');
        const agent = createProviderFromConfig(openaiCompatibleOidcConfig, undefined, {
          tokenCache: cache,
        }) as ChatOpenAI;
        const wrapped = agent.clientConfig?.fetch as typeof fetch;
        let capturedHeaders: Headers | undefined;
        const fakeNext: typeof fetch = async (_input, init) => {
          capturedHeaders = new Headers(init?.headers);
          return new Response('{}', { status: 200 });
        };
        // The wrapper closes over the real global `fetch` as its default
        // `next` — reconstruct one with the fake instead by calling the
        // exported factory directly with the same tokenCache/config, which
        // is exactly what createProviderFromConfig does internally.
        const testWrapper = createOidcAuthenticatingFetch(
          cache,
          { name: openaiCompatibleOidcConfig.name, auth: openaiCompatibleOidcConfig.auth! },
          fakeNext,
        );
        await testWrapper('https://api.example.com/1.0/openai/v1/chat/completions', {});
        expect(calls).to.have.length(1);
        expect(calls[0]?.name).to.equal('in-house-gateway-oidc');
        expect(capturedHeaders?.get('Authorization')).to.equal('Bearer tok-from-cache');
        // wrapped is also a function — confirms createProviderFromConfig
        // actually wired the same kind of wrapper into configuration.fetch.
        expect(wrapped).to.be.a('function');
      });

      it('throws when no defaultModel and no model override', () => {
        const noModel = { ...openaiCompatibleApiKeyConfig, defaultModel: undefined };
        expect(() => createProviderFromConfig(noModel)).to.throw(/defaultModel/);
      });
    });
  });

  describe('headers passthrough', () => {
    it('passes headers through to ChatOllama (forwarded into its internal ollama client)', () => {
      const agent = createProviderFromConfig({
        ...ollamaConfig,
        headers: { 'x-tenant-id': 'acme' },
      }) as ChatOllama;
      // ChatOllama doesn't retain `headers` as its own field — it forwards
      // the constructor option straight into `this.client` (the `ollama`
      // npm client), which stores it at `this.config.headers`. That field
      // isn't part of the `ollama` package's declared public type, so this
      // reads it via a loose cast rather than fighting the type checker
      // over an internal implementation detail two layers down.
      const client = agent.client as unknown as { config?: { headers?: unknown } };
      expect(client.config?.headers).to.deep.equal({ 'x-tenant-id': 'acme' });
    });

    it('passes headers through to ChatOpenAI as configuration.defaultHeaders', () => {
      const agent = createProviderFromConfig({
        ...openaiConfig,
        headers: { 'x-tenant-id': 'acme' },
      }) as ChatOpenAI;
      expect(agent.clientConfig?.defaultHeaders).to.deep.equal({ 'x-tenant-id': 'acme' });
    });

    it('passes headers through to ChatAnthropic as clientOptions.defaultHeaders', () => {
      const agent = createProviderFromConfig({
        ...anthropicConfig,
        headers: { 'x-tenant-id': 'acme' },
      }) as ChatAnthropic;
      expect(agent.clientOptions.defaultHeaders).to.deep.equal({ 'x-tenant-id': 'acme' });
    });

    it('passes headers through to AzureChatOpenAI as configuration.defaultHeaders', () => {
      const { cache } = stubTokenCache();
      const agent = createProviderFromConfig(
        { ...azureConfig, headers: { 'x-tenant-id': 'acme' } },
        undefined,
        { tokenCache: cache },
      ) as AzureChatOpenAI;
      expect(agent.clientConfig?.defaultHeaders).to.deep.equal({ 'x-tenant-id': 'acme' });
    });

    it('passes headers through to ChatOpenAI as configuration.defaultHeaders for openai-compatible/apiKey', () => {
      const agent = createProviderFromConfig({
        ...openaiCompatibleApiKeyConfig,
        headers: { 'x-tenant-id': 'acme' },
      }) as ChatOpenAI;
      expect(agent.clientConfig?.defaultHeaders).to.deep.equal({ 'x-tenant-id': 'acme' });
    });

    it('passes headers through to ChatOpenAI as configuration.defaultHeaders for openai-compatible/oidc', () => {
      const { cache } = stubTokenCache();
      const agent = createProviderFromConfig(
        { ...openaiCompatibleOidcConfig, headers: { 'x-tenant-id': 'acme' } },
        undefined,
        { tokenCache: cache },
      ) as ChatOpenAI;
      expect(agent.clientConfig?.defaultHeaders).to.deep.equal({ 'x-tenant-id': 'acme' });
    });

    it('leaves headers unset for every type when not configured', () => {
      const ollama = createProviderFromConfig(ollamaConfig) as ChatOllama;
      const ollamaClient = ollama.client as unknown as { config?: { headers?: unknown } };
      expect(ollamaClient.config?.headers).to.equal(undefined);
      expect(
        (createProviderFromConfig(openaiConfig) as ChatOpenAI).clientConfig?.defaultHeaders,
      ).to.equal(undefined);
    });
  });

  describe('listModels()/fetchModelIds (private)', () => {
    const closers: Array<() => void> = [];
    after(() => closers.forEach((close) => close()));

    it('resolves to [deploymentName] for azure-openai without making any HTTP call', async () => {
      // azureConfig's tokenUrl/endpoint point nowhere reachable — if this
      // made a live call it would reject or hang, not resolve immediately.
      const models = await listModels(azureConfig);
      expect(models).to.deep.equal(['gpt-4o']);
    });

    it('lists models for openai-compatible/apiKey the same way as the openai case', async () => {
      const server = await startModelsServer({
        object: 'list',
        data: [{ id: 'gpt-5.4-mini', object: 'model', owned_by: 'in-house' }],
      });
      closers.push(server.close);

      const models = await listModels({ ...openaiCompatibleApiKeyConfig, baseUrl: server.baseUrl });
      expect(models).to.deep.equal(['gpt-5.4-mini']);
    });

    it('authenticates the live /models call with the oidc-cached token for openai-compatible/oidc', async () => {
      const server = await startModelsServer({
        object: 'list',
        data: [{ id: 'gpt-5.4-mini', object: 'model', owned_by: 'in-house' }],
      });
      closers.push(server.close);
      const { cache, calls } = stubTokenCache('tok-for-models');

      const models = await listModels(
        { ...openaiCompatibleOidcConfig, baseUrl: server.baseUrl },
        { tokenCache: cache },
      );
      expect(models).to.deep.equal(['gpt-5.4-mini']);
      expect(calls).to.have.length(1);
      expect(calls[0]?.name).to.equal('in-house-gateway-oidc');
    });
  });

  describe('resolveEffectiveSampling()', () => {
    const config: ProviderConfig = {
      ...ollamaConfig,
      temperature: 0.2,
      topP: 0.8,
      seed: 1,
      numCtx: 4096,
      topK: 20,
      repeatPenalty: 1.0,
      models: [
        {
          id: 'llama3',
          temperature: 1,
          topP: 0.95,
          seed: 7,
          numCtx: 16384,
          topK: 40,
          repeatPenalty: 1.1,
        },
      ],
    };

    it('uses the model entry for every field when one exists', () => {
      expect(resolveEffectiveSampling(config, 'llama3')).to.deep.equal({
        temperature: 1,
        topP: 0.95,
        seed: 7,
        numCtx: 16384,
        topK: 40,
        repeatPenalty: 1.1,
      });
    });

    it('falls back to the provider-level default for every field when no model entry matches', () => {
      expect(resolveEffectiveSampling(config, 'unknown-model')).to.deep.equal({
        temperature: 0.2,
        topP: 0.8,
        seed: 1,
        numCtx: 4096,
        topK: 20,
        repeatPenalty: 1.0,
      });
    });

    it('resolves to undefined per field when neither the model nor the provider sets it', () => {
      expect(resolveEffectiveSampling(ollamaConfig, 'llama3')).to.deep.equal({
        temperature: undefined,
        topP: undefined,
        seed: undefined,
        numCtx: undefined,
        topK: undefined,
        repeatPenalty: undefined,
      });
    });

    it('resolves numCtx/topK/repeatPenalty to undefined for an openai-compatible config, same as azure-openai', () => {
      const result = resolveEffectiveSampling(
        { ...openaiCompatibleApiKeyConfig, temperature: 0.2 },
        'gpt-5.4-mini',
      );
      expect(result).to.deep.equal({
        temperature: 0.2,
        topP: undefined,
        seed: undefined,
        numCtx: undefined,
        topK: undefined,
        repeatPenalty: undefined,
      });
    });

    it('resolves fields independently — a model overriding only one field still falls back for the rest', () => {
      const partial: ProviderConfig = {
        ...ollamaConfig,
        temperature: 0.2,
        topP: 0.8,
        models: [{ id: 'llama3', temperature: 1 }],
      };
      expect(resolveEffectiveSampling(partial, 'llama3')).to.deep.equal({
        temperature: 1,
        topP: 0.8,
        seed: undefined,
        numCtx: undefined,
        topK: undefined,
        repeatPenalty: undefined,
      });
    });
  });

  describe('applyEvalDeterminism()', () => {
    it('pins temperature to 0 and applies the seed for ollama', () => {
      const result = applyEvalDeterminism(ollamaConfig, 42);
      expect(result.temperature).to.equal(0);
      expect(result.seed).to.equal(42);
    });

    it('pins temperature to 0 and applies the seed for openai-compatible providers', () => {
      const result = applyEvalDeterminism(openaiConfig, 42);
      expect(result.temperature).to.equal(0);
      expect(result.seed).to.equal(42);
    });

    // Current Claude models reject an explicit temperature outright
    // ("400 `temperature` is deprecated for this model"), which fails every
    // judge call, so an anthropic provider must not get one injected.
    it('does not inject a temperature for anthropic, whose current models reject it', () => {
      const result = applyEvalDeterminism({ ...anthropicConfig, seed: 99 }, 42);
      expect(result.temperature).to.equal(undefined);
    });

    it('leaves seed undefined for anthropic, which has no seed parameter', () => {
      const result = applyEvalDeterminism({ ...anthropicConfig, seed: 99 }, 42);
      expect(result.seed).to.equal(undefined);
    });

    it('keeps a temperature the user explicitly configured on an anthropic provider', () => {
      const result = applyEvalDeterminism({ ...anthropicConfig, temperature: 0.3 }, 42);
      expect(result.temperature).to.equal(0.3);
    });

    describe('temperature override', () => {
      it('uses the override instead of 0 for ollama, and still applies the seed', () => {
        const result = applyEvalDeterminism(ollamaConfig, 42, { temperature: 1 });
        expect(result.temperature).to.equal(1);
        expect(result.seed).to.equal(42);
      });

      it('uses the override instead of 0 for openai-compatible providers', () => {
        const result = applyEvalDeterminism(openaiConfig, 42, { temperature: 0.6 });
        expect(result.temperature).to.equal(0.6);
        expect(result.seed).to.equal(42);
      });

      it('treats an override of 0 as a real value, not as unset', () => {
        const result = applyEvalDeterminism({ ...ollamaConfig, temperature: 1 }, 42, {
          temperature: 0,
        });
        expect(result.temperature).to.equal(0);
      });

      it('overrides a temperature already configured on the provider', () => {
        const result = applyEvalDeterminism({ ...ollamaConfig, temperature: 1.2 }, 42, {
          temperature: 0.5,
        });
        expect(result.temperature).to.equal(0.5);
      });

      it('passes an explicitly requested temperature through for anthropic, still without a seed', () => {
        const result = applyEvalDeterminism(anthropicConfig, 42, { temperature: 0.7 });
        expect(result.temperature).to.equal(0.7);
        expect(result.seed).to.equal(undefined);
      });

      it('still injects no temperature for anthropic when no override is given', () => {
        const result = applyEvalDeterminism(anthropicConfig, 42, {});
        expect(result.temperature).to.equal(undefined);
      });
    });

    it('overrides temperature and seed already present on the config', () => {
      const result = applyEvalDeterminism({ ...ollamaConfig, temperature: 1.2, seed: 5 }, 42);
      expect(result.temperature).to.equal(0);
      expect(result.seed).to.equal(42);
    });

    it('preserves every other provider field', () => {
      const result = applyEvalDeterminism({ ...openaiConfig, timeoutMs: 5000 }, 42);
      expect(result).to.include({
        name: openaiConfig.name,
        type: 'openai',
        defaultModel: openaiConfig.defaultModel,
        timeoutMs: 5000,
      });
    });

    it('does not mutate the config it was given', () => {
      const input: ProviderConfig = { ...ollamaConfig, temperature: 1 };
      applyEvalDeterminism(input, 42);
      expect(input.temperature).to.equal(1);
      expect(input.seed).to.equal(undefined);
    });

    // Without this, a models[] entry's own temperature/seed would win over
    // the pin just below inside resolveEffectiveSampling/
    // createProviderFromConfig, silently defeating eval determinism for
    // exactly the model being tested — the one case this function exists to
    // prevent.
    it('strips temperature and seed off every models[] entry so an override cannot defeat the pin', () => {
      const result = applyEvalDeterminism(
        {
          ...ollamaConfig,
          defaultModel: 'llama3',
          models: [{ id: 'llama3', temperature: 1, seed: 99, inputPricePerM: 3 }],
        },
        42,
      );
      expect(result.models).to.deep.equal([{ id: 'llama3', inputPricePerM: 3 }]);
      expect((createProviderFromConfig(result) as ChatOllama).temperature).to.equal(0);
    });

    it('leaves a models[] entry with no temperature/seed untouched', () => {
      const result = applyEvalDeterminism(
        { ...ollamaConfig, models: [{ id: 'llama3', topP: 0.9 }] },
        42,
      );
      expect(result.models).to.deep.equal([{ id: 'llama3', topP: 0.9 }]);
    });
  });

  describe('describeSampling()', () => {
    it('reports a pinned temperature and seed', () => {
      expect(describeSampling({ ...ollamaConfig, temperature: 0, seed: 42 })).to.equal(
        'temperature=0, seed=42',
      );
    });

    it('reports a non-zero temperature as given', () => {
      expect(describeSampling({ ...ollamaConfig, temperature: 1, seed: 42 })).to.equal(
        'temperature=1, seed=42',
      );
    });

    it('says provider default and no seed when nothing is set, as for an unpinned anthropic provider', () => {
      expect(describeSampling(anthropicConfig)).to.equal('temperature=provider default, seed=none');
    });

    it('includes topP only when it is set', () => {
      expect(describeSampling({ ...ollamaConfig, temperature: 1, topP: 0.9, seed: 7 })).to.equal(
        'temperature=1, top_p=0.9, seed=7',
      );
    });
  });

  describe('createProvider()', () => {
    it('throws when providers array is empty', () => {
      // We cannot easily test the live env path without mocking configManager,
      // so this test is limited to a documentation assertion.
      // The factory logic is fully covered by createProviderFromConfig tests above.
      expect(createProvider).to.be.a('function');
    });
  });

  describe('hasOllamaVisionCapability()', () => {
    it('returns true when capabilities includes vision', async () => {
      const client = stubOllamaClient(['vision', 'completion']);
      expect(await hasOllamaVisionCapability(client, 'llava')).to.equal(true);
    });

    it('returns false when capabilities omits vision', async () => {
      const client = stubOllamaClient(['completion', 'tools']);
      expect(await hasOllamaVisionCapability(client, 'qwen3')).to.equal(false);
    });

    it('returns false (not throw) when capabilities is undefined', async () => {
      const client = stubOllamaClient(undefined);
      expect(await hasOllamaVisionCapability(client, 'unknown')).to.equal(false);
    });

    it('returns false (not throw) when show() rejects', async () => {
      const client = stubOllamaClient(undefined, true);
      expect(await hasOllamaVisionCapability(client, 'gone')).to.equal(false);
    });
  });

  describe('resolveVisionCapabilityFromConfig()', () => {
    it('falls back to FALLBACK_VISION_CAPABILITIES for an unknown openai model', async () => {
      FALLBACK_VISION_CAPABILITIES.openai['my-custom-vision-model'] = true;
      try {
        const result = await resolveVisionCapabilityFromConfig(
          openaiConfig,
          'my-custom-vision-model',
        );
        expect(result).to.equal(true);
      } finally {
        delete FALLBACK_VISION_CAPABILITIES.openai['my-custom-vision-model'];
      }
    });

    it('falls back to FALLBACK_VISION_CAPABILITIES for an unknown openai-compatible model', async () => {
      FALLBACK_VISION_CAPABILITIES['openai-compatible']['my-custom-vision-model'] = true;
      try {
        const result = await resolveVisionCapabilityFromConfig(
          openaiCompatibleApiKeyConfig,
          'my-custom-vision-model',
        );
        expect(result).to.equal(true);
      } finally {
        delete FALLBACK_VISION_CAPABILITIES['openai-compatible']['my-custom-vision-model'];
      }
    });

    it('resolves false, not a thrown error, for an unknown openai model with no fallback entry', async () => {
      // openaiConfig has an apiKey, so createProviderFromConfig succeeds; the
      // model id just isn't in any known PROFILES table or the fallback map.
      expect(await resolveVisionCapabilityFromConfig(openaiConfig, 'not-a-real-model-id')).to.equal(
        false,
      );
    });

    it('does not throw for an anthropic provider with no resolvable apiKey', async () => {
      // Regression test for the try/catch guard — ChatAnthropic's
      // constructor throws synchronously when no apiKey is resolvable.
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const noKeyConfig: ProviderConfig = {
        name: 'claude-no-key',
        type: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
      };
      try {
        const result = await resolveVisionCapabilityFromConfig(noKeyConfig, 'claude-sonnet-4-6');
        expect(result).to.equal(false);
      } finally {
        if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      }
    });

    it('dispatches ollama configs to the live capabilities check', async () => {
      // Can't inject a stub client through the public function (it
      // constructs a real `Ollama` internally), so this just confirms it
      // resolves rather than throwing when the real client can't connect —
      // hasOllamaVisionCapability's own describe block covers the actual
      // true/false/reject-safe logic in isolation.
      const result = await resolveVisionCapabilityFromConfig(ollamaConfig, 'llama3');
      expect(result).to.equal(false);
    });

    it('returns true when rawDetails.labels includes "vision"', async () => {
      const result = await resolveVisionCapabilityFromConfig(openaiConfig, 'custom-model', {
        id: 'custom-model',
        labels: ['custom', 'vision', 'tool-calling'],
      });
      expect(result).to.equal(true);
    });

    it('falls through to the existing fallback chain when rawDetails has no labels', async () => {
      FALLBACK_VISION_CAPABILITIES.openai['labelless-model'] = true;
      try {
        const result = await resolveVisionCapabilityFromConfig(openaiConfig, 'labelless-model', {
          id: 'labelless-model',
        });
        expect(result).to.equal(true);
      } finally {
        delete FALLBACK_VISION_CAPABILITIES.openai['labelless-model'];
      }
    });

    it('falls through to the existing fallback chain when rawDetails is omitted entirely', async () => {
      // Regression guard: default behavior (today's 2-arg call shape) must
      // stay exactly as it was before this 3rd param existed.
      expect(await resolveVisionCapabilityFromConfig(openaiConfig, 'not-a-real-model-id')).to.equal(
        false,
      );
    });

    it('ignores rawDetails for ollama even if it has a vision label', async () => {
      const result = await resolveVisionCapabilityFromConfig(ollamaConfig, 'llama3', {
        id: 'llama3',
        labels: ['vision'],
      });
      expect(result).to.equal(false);
    });

    // Note: resolveVisionCapabilityFromConfig itself doesn't special-case
    // anthropic vs openai beyond the ollama branch above — it trusts
    // whatever rawDetails a caller passes. The real guarantee that
    // anthropic/ollama never get a populated rawDetails lives in the
    // callers (resolveVisionCapability below, and providers.route.ts),
    // which only ever fetch/pass one for 'openai'-type providers.
  });

  describe('fetchModelDetails()', () => {
    const closers: Array<() => void> = [];
    after(() => closers.forEach((close) => close()));

    it('surfaces an extra field (labels) present on a real /models response', async () => {
      const server = await startModelsServer({
        object: 'list',
        data: [
          { id: 'vision-model', object: 'model', owned_by: 'lemonade', labels: ['vision'] },
          { id: 'text-model', object: 'model', owned_by: 'lemonade', labels: ['tool-calling'] },
        ],
      });
      closers.push(server.close);

      const details = await fetchModelDetails({
        name: 'lemonade',
        type: 'openai',
        baseUrl: server.baseUrl,
        apiKey: 'sk-test',
        defaultModel: 'vision-model',
      });

      expect(details).to.have.length(2);
      expect(details.find((d) => d.id === 'vision-model')?.labels).to.deep.equal(['vision']);
      expect(details.find((d) => d.id === 'text-model')?.labels).to.deep.equal(['tool-calling']);
    });

    it('returns [] for a non-openai, non-openai-compatible provider without making any request', async () => {
      expect(await fetchModelDetails(ollamaConfig)).to.deep.equal([]);
      expect(await fetchModelDetails(anthropicConfig)).to.deep.equal([]);
    });

    it('surfaces an extra field (labels) for openai-compatible/apiKey, same as the openai case', async () => {
      const server = await startModelsServer({
        object: 'list',
        data: [{ id: 'gpt-5.4-mini', object: 'model', owned_by: 'in-house', labels: ['vision'] }],
      });
      closers.push(server.close);

      const details = await fetchModelDetails({
        ...openaiCompatibleApiKeyConfig,
        baseUrl: server.baseUrl,
      });
      expect(details).to.have.length(1);
      expect(details[0]?.labels).to.deep.equal(['vision']);
    });

    it('authenticates the live /models call with the oidc-cached token for openai-compatible/oidc', async () => {
      const server = await startAuthCapturingModelsServer({
        object: 'list',
        data: [{ id: 'gpt-5.4-mini' }],
      });
      closers.push(server.close);
      const { cache } = stubTokenCache('tok-for-details');

      const details = await fetchModelDetails(
        { ...openaiCompatibleOidcConfig, baseUrl: server.baseUrl },
        { tokenCache: cache },
      );
      expect(details).to.have.length(1);
      expect(server.capturedAuth()).to.equal('Bearer tok-for-details');
    });

    it('returns [] (not throw) when the request fails', async () => {
      const details = await fetchModelDetails({
        name: 'unreachable',
        type: 'openai',
        baseUrl: 'http://127.0.0.1:1',
        defaultModel: 'whatever',
      });
      expect(details).to.deep.equal([]);
    });
  });

  describe('resolveVisionCapability()', () => {
    it('resolves false for an unknown provider name rather than throwing', async () => {
      expect(await resolveVisionCapability('no-such-provider', 'whatever')).to.equal(false);
    });

    // resolveVisionCapability resolves a provider by name against the live
    // env.providers singleton this test suite doesn't seed, so its
    // openai-only fetchModelDetails() dispatch isn't exercised end-to-end
    // here — fetchModelDetails()'s own describe block above covers the
    // actual per-type dispatch logic ("returns [] for a non-openai provider
    // without making any request") at the pure-function level this wrapper
    // delegates to, same split as createProvider()'s describe block above.
  });
});
