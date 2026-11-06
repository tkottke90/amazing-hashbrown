import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { configManager } from '../config/env.js';
import { bootObservability } from '../services/observability.js';
import { rewriteTaskForHandOffGuidance } from './hand-off-guidance.js';

class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

describe('agents/hand-off-guidance', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hand-off-guidance-test-'));
    bootObservability(openDatabase(join(dir, 'observability.db')));
    configManager.set('providers', [
      {
        name: 'local',
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'test-model',
      },
    ]);
    configManager.set('defaultProvider', 'local');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  const input = {
    title: 'Fix the flaky test',
    description: null,
    handOffNote: 'Ran out of steps twice with unchanged scope.',
    guidance: 'Narrow it to just the login spec.',
  };

  it('parses a valid JSON rewrite [unit]', async () => {
    const model = new FakeListChatModel({
      responses: ['{"title":"Fix the flaky login test","description":"Focus on login only"}'],
    });

    const result = await rewriteTaskForHandOffGuidance(model, undefined, undefined, input);

    expect(result).to.deep.equal({
      title: 'Fix the flaky login test',
      description: 'Focus on login only',
    });
  });

  it('strips a markdown code fence around the JSON [unit]', async () => {
    const model = new FakeListChatModel({
      responses: ['```json\n{"title":"Fixed title","description":null}\n```'],
    });

    const result = await rewriteTaskForHandOffGuidance(model, undefined, undefined, input);

    expect(result).to.deep.equal({ title: 'Fixed title', description: null });
  });

  it('throws (never swallows) on malformed JSON [unit]', async () => {
    const model = new FakeListChatModel({ responses: ['sure, here you go'] });

    let caught: unknown;
    try {
      await rewriteTaskForHandOffGuidance(model, undefined, undefined, input);
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
  });

  it('throws when the model itself throws [unit]', async () => {
    let caught: unknown;
    try {
      await rewriteTaskForHandOffGuidance(new ThrowingChatModel({}), undefined, undefined, input);
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
  });

  it('includes the Hand-Off Note and guidance in the prompt [unit]', async () => {
    let capturedPrompt = '';
    class CapturingModel extends FakeListChatModel {
      override async invoke(promptInput: unknown, options?: unknown) {
        capturedPrompt = String(promptInput);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return super.invoke(promptInput as any, options as any);
      }
    }
    const model = new CapturingModel({ responses: ['{"title":"x","description":null}'] });

    await rewriteTaskForHandOffGuidance(model, undefined, undefined, input);

    expect(capturedPrompt).to.include(input.handOffNote);
    expect(capturedPrompt).to.include(input.guidance);
  });
});
