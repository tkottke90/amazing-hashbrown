import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import type { WorkspaceRetrospectiveData } from '@tkottke90/workspace-reports';
import { bootObservability } from '../services/observability.js';
import { configManager } from '../config/env.js';
import { logger } from '../config/logger.js';
import { generateRetrospectiveNarrative } from './workspace-retrospective-narrative.js';

enum TestTypes {
  UNIT = '[unit]',
}

class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

class RecordingChatModel extends BaseChatModel {
  public lastMessages: BaseMessage[] = [];

  constructor(private readonly responseText: string) {
    super({});
  }

  _llmType() {
    return 'recording-fake';
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.lastMessages = messages;
    return {
      generations: [{ message: new AIMessage(this.responseText), text: this.responseText }],
    };
  }
}

function captureLogCalls(method: 'error') {
  const spy = logger as unknown as Record<string, (msg: string, meta?: unknown) => void>;
  const original = spy[method].bind(logger);
  const calls: Array<{ message: string; meta: unknown }> = [];
  spy[method] = (message: string, meta?: unknown) => {
    calls.push({ message, meta });
    original(message, meta);
  };
  return {
    calls,
    restore: () => {
      spy[method] = original;
    },
  };
}

function fixtureData(
  overrides: Partial<WorkspaceRetrospectiveData> = {},
): WorkspaceRetrospectiveData {
  return {
    workspaceId: 'ws-1',
    generatedAt: '2026-07-18T12:00:00.000Z',
    workspace: {
      id: 'ws-1',
      name: 'Gmail Labeler',
      goal: 'Automatically label incoming Gmail messages',
      wikiId: 'personal',
      threadId: null,
      createdAt: '2026-07-18T08:00:00.000Z',
    },
    chat: null,
    tasks: [
      {
        taskId: 'task-1',
        title: 'Build the labeler automation',
        status: 'failed',
        origin: 'agent',
        provider: 'ollama',
        model: 'qwen3:14b',
        runs: [],
        progressEntries: [],
      },
    ],
    anomalies: [
      {
        kind: 'repeated_failures',
        taskId: 'task-1',
        taskTitle: 'Build the labeler automation',
        attempts: 2,
        lastSummary: 'Hit a tool error twice in a row',
      },
    ],
    summary: { taskCount: 1, runCount: 0, failureCount: 0, wikiWriteCount: 0, anomalyCount: 1 },
    narrative: null,
    ...overrides,
  };
}

describe('agents/workspace-retrospective-narrative', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-retrospective-narrative-test-'));
    const obsDb = openDatabase(join(dir, 'observability.db'));
    bootObservability(obsDb);

    configManager.set('providers', [
      {
        name: 'local',
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'test-narrative-model',
      },
    ]);
    configManager.set('defaultProvider', 'local');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  it(`returns the trimmed model response on success ${TestTypes.UNIT}`, async () => {
    const model = new RecordingChatModel('  ## Likely causes\n\nIt timed out.  ');
    const result = await generateRetrospectiveNarrative({ data: fixtureData(), model });
    expect(result).to.equal('## Likely causes\n\nIt timed out.');
  });

  it(`includes the workspace goal, task ledger and flagged anomalies in the prompt ${TestTypes.UNIT}`, async () => {
    const model = new RecordingChatModel('narrative');
    await generateRetrospectiveNarrative({ data: fixtureData(), model });

    const prompt = String(model.lastMessages[0]?.content ?? '');
    expect(prompt).to.include('Automatically label incoming Gmail messages');
    expect(prompt).to.include('Build the labeler automation');
    expect(prompt).to.include('repeated_failures');
    expect(prompt).to.include('Hit a tool error twice in a row');
  });

  it(`returns null and logs an error when the model call throws, rather than failing the report ${TestTypes.UNIT}`, async () => {
    const log = captureLogCalls('error');
    try {
      const result = await generateRetrospectiveNarrative({
        data: fixtureData(),
        model: new ThrowingChatModel({}),
      });
      expect(result).to.equal(null);
      expect(log.calls).to.have.length(1);
      expect(log.calls[0]?.message).to.include('generation failed');
    } finally {
      log.restore();
    }
  });

  it(`returns null when the model responds with only whitespace ${TestTypes.UNIT}`, async () => {
    const model = new RecordingChatModel('   \n  ');
    const result = await generateRetrospectiveNarrative({ data: fixtureData(), model });
    expect(result).to.equal(null);
  });
});
