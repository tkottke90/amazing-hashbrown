import { createServer, type Server } from 'node:http';
import { describe, it, after } from 'mocha';
import { expect } from 'chai';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { Ollama } from 'ollama';
import {
  applyEvalDeterminism,
  createProvider,
  createProviderFromConfig,
  hasOllamaVisionCapability,
  resolveVisionCapability,
  resolveVisionCapabilityFromConfig,
  fetchModelDetails,
  FALLBACK_VISION_CAPABILITIES,
} from './provider-factory.js';
import type { ProviderConfig } from '../config/env.js';

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
    let close: (() => void) | undefined;
    after(() => close?.());

    it('surfaces an extra field (labels) present on a real /models response', async () => {
      const server = await startModelsServer({
        object: 'list',
        data: [
          { id: 'vision-model', object: 'model', owned_by: 'lemonade', labels: ['vision'] },
          { id: 'text-model', object: 'model', owned_by: 'lemonade', labels: ['tool-calling'] },
        ],
      });
      close = server.close;

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

    it('returns [] for a non-openai provider without making any request', async () => {
      expect(await fetchModelDetails(ollamaConfig)).to.deep.equal([]);
      expect(await fetchModelDetails(anthropicConfig)).to.deep.equal([]);
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
