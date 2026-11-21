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
import type { ThreadReportData, ThreadReportStats } from '@tkottke90/thread-reports';
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
    handoffs: [],
    summary: {
      taskCount: 1,
      runCount: 0,
      failureCount: 0,
      wikiWriteCount: 0,
      anomalyCount: 1,
      handoffCount: 0,
    },
    narrative: null,
    ...overrides,
  };
}

// Failure Breakdown / Tool-Call Distribution fixtures (see GLOSSARY.md) —
// no literal of either exists elsewhere in this file, since fixtureData()'s
// chat is null and its one task has no runs.
function makeThreadReportStats(overrides: Partial<ThreadReportStats> = {}): ThreadReportStats {
  return {
    turnCount: 0,
    toolCallCount: 0,
    mostPopularTool: null,
    failureCount: 0,
    wikiWriteCount: 0,
    toolCallCounts: {},
    toolFailureCounts: {},
    otherFailures: {},
    toolInterruptCounts: {},
    ...overrides,
  };
}

function makeThreadReport(statsOverrides: Partial<ThreadReportStats> = {}): ThreadReportData {
  return {
    threadId: 'thread-1',
    generatedAt: '2026-07-18T12:00:00.000Z',
    thread: {
      id: 'thread-1',
      title: 'Thread',
      createdAt: '2026-07-18T08:00:00.000Z',
      updatedAt: '2026-07-18T08:00:00.000Z',
      forkedFromThreadId: null,
      forkedFromSeq: null,
      messages: [],
    },
    stats: makeThreadReportStats(statsOverrides),
    timeline: [],
    recursion: { recursionLimit: 100, recursionWarnThreshold: 0.75 },
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

  it(`includes handoffs in the prompt, labeled as not failures (issue #364) ${TestTypes.UNIT}`, async () => {
    const model = new RecordingChatModel('narrative');
    await generateRetrospectiveNarrative({
      data: fixtureData({
        handoffs: [
          {
            taskId: 'task-2',
            taskTitle: 'Migrate config',
            count: 1,
            lastSummary: 'Stopped at the user’s request.',
          },
        ],
      }),
      model,
    });

    const prompt = String(model.lastMessages[0]?.content ?? '');
    expect(prompt).to.include('Migrate config');
    expect(prompt).to.include('Stopped at the user’s request.');
    expect(prompt).to.include('not failures');
  });

  it(`tells the model to ground causes in the evidence, not the goal text ${TestTypes.UNIT}`, async () => {
    const model = new RecordingChatModel('narrative');
    await generateRetrospectiveNarrative({ data: fixtureData(), model });

    const prompt = String(model.lastMessages[0]?.content ?? '');
    expect(prompt).to.include('ground every claimed cause in the evidence below');
  });

  it(`renders the chat thread's Failure Breakdown as sub-bullets, with a failure ratio for a tool that failed and a plain count for one that didn't ${TestTypes.UNIT}`, async () => {
    const model = new RecordingChatModel('narrative');
    await generateRetrospectiveNarrative({
      data: fixtureData({
        chat: makeThreadReport({
          toolCallCount: 35,
          failureCount: 23,
          toolCallCounts: { fetch_url: 23, read_wiki_page: 12 },
          toolFailureCounts: { fetch_url: { count: 23, example: 'fetch failed: ETIMEDOUT' } },
        }),
      }),
      model,
    });

    const prompt = String(model.lastMessages[0]?.content ?? '');
    expect(prompt).to.include('  - fetch_url: 23/23 failed');
    expect(prompt).to.include('  - read_wiki_page: 12 calls');
  });

  it(`caps the chat thread's tool distribution at the top 8 by count, with a rollup note for the rest ${TestTypes.UNIT}`, async () => {
    const toolCallCounts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      toolCallCounts[`tool_${i}`] = 10 - i;
    }
    const model = new RecordingChatModel('narrative');
    await generateRetrospectiveNarrative({
      data: fixtureData({
        chat: makeThreadReport({ toolCallCount: 55, toolCallCounts }),
      }),
      model,
    });

    const prompt = String(model.lastMessages[0]?.content ?? '');
    for (let i = 0; i < 8; i++) {
      expect(prompt).to.include(`tool_${i}`);
    }
    expect(prompt).to.not.include('tool_8');
    expect(prompt).to.not.include('tool_9');
    expect(prompt).to.include('(+2 more tools)');
  });

  it(`truncates a Failure Breakdown example message to 120 characters in the prompt ${TestTypes.UNIT}`, async () => {
    const longExample = `This turn produced more tool output than the configured context budget allows, even after truncating every tool result in it. ${'x'.repeat(200)}`;
    const model = new RecordingChatModel('narrative');
    await generateRetrospectiveNarrative({
      data: fixtureData({
        chat: makeThreadReport({
          failureCount: 1,
          otherFailures: { context_length: { count: 1, example: longExample } },
        }),
      }),
      model,
    });

    const prompt = String(model.lastMessages[0]?.content ?? '');
    expect(prompt).to.include(`${longExample.slice(0, 120)}...`);
    expect(prompt).to.not.include(longExample);
  });

  it(`omits the chat thread's tool-distribution and other-failures bullets entirely when nothing was called or failed ${TestTypes.UNIT}`, async () => {
    const model = new RecordingChatModel('narrative');
    await generateRetrospectiveNarrative({
      data: fixtureData({ chat: makeThreadReport() }),
      model,
    });

    const prompt = String(model.lastMessages[0]?.content ?? '');
    const lines = prompt.split('\n');
    const chatLineIndex = lines.findIndex((l) => l.startsWith('Chat:'));
    expect(chatLineIndex).to.be.greaterThan(-1);
    expect(lines[chatLineIndex + 1]).to.match(/^Tasks \(/);
  });

  it(`renders a task run's Failure Breakdown as sub-bullets, with a failure ratio ${TestTypes.UNIT}`, async () => {
    const model = new RecordingChatModel('narrative');
    await generateRetrospectiveNarrative({
      data: fixtureData({
        tasks: [
          {
            taskId: 'task-1',
            title: 'Build the labeler automation',
            status: 'failed',
            origin: 'agent',
            provider: 'ollama',
            model: 'qwen3:14b',
            runs: [
              {
                runId: 'run-1',
                runNumber: 1,
                status: 'failed',
                summary: null,
                recoveryAttempts: 0,
                threadReport: makeThreadReport({
                  toolCallCount: 10,
                  failureCount: 10,
                  toolCallCounts: { gmail_mcp_apply_label: 10 },
                  toolFailureCounts: {
                    gmail_mcp_apply_label: { count: 10, example: 'MCP server disconnected' },
                  },
                }),
              },
            ],
            progressEntries: [],
          },
        ],
      }),
      model,
    });

    const prompt = String(model.lastMessages[0]?.content ?? '');
    expect(prompt).to.include('      - gmail_mcp_apply_label: 10/10 failed');
  });

  it(`omits a task run's tool-distribution and other-failures bullets entirely when it has no thread report ${TestTypes.UNIT}`, async () => {
    const model = new RecordingChatModel('narrative');
    await generateRetrospectiveNarrative({
      data: fixtureData({
        tasks: [
          {
            taskId: 'task-1',
            title: 'Build the labeler automation',
            status: 'failed',
            origin: 'agent',
            provider: 'ollama',
            model: 'qwen3:14b',
            runs: [
              {
                runId: 'run-1',
                runNumber: 1,
                status: 'failed',
                summary: null,
                recoveryAttempts: 0,
                threadReport: null,
              },
            ],
            progressEntries: [],
          },
        ],
      }),
      model,
    });

    const prompt = String(model.lastMessages[0]?.content ?? '');
    const lines = prompt.split('\n');
    const runLineIndex = lines.findIndex((l) => l.includes('run #1:'));
    expect(runLineIndex).to.be.greaterThan(-1);
    expect(lines[runLineIndex + 1]).to.match(/^Anomalies flagged \(/);
  });
});
