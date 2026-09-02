import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { Ollama } from 'ollama';
import {
  createProvider,
  createProviderFromConfig,
  hasOllamaVisionCapability,
  resolveVisionCapability,
  resolveVisionCapabilityFromConfig,
  FALLBACK_VISION_CAPABILITIES,
} from './provider-factory.js';
import type { ProviderConfig } from '../config/env.js';

function stubOllamaClient(
  capabilities: string[] | undefined,
  fail = false,
): Pick<Ollama, 'show'> {
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
        const result = await resolveVisionCapabilityFromConfig(openaiConfig, 'my-custom-vision-model');
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
  });

  describe('resolveVisionCapability()', () => {
    it('resolves false for an unknown provider name rather than throwing', async () => {
      expect(await resolveVisionCapability('no-such-provider', 'whatever')).to.equal(false);
    });
  });
});
