import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { ThreadReportData } from '@tkottke90/thread-reports';
import { renderTaskRunReportHtml } from '../../src/render.js';
import type { TaskRunReportData, TaskRunRetrospective } from '../../src/types.js';

function threadReportFixture(overrides: Partial<ThreadReportData> = {}): ThreadReportData {
  return {
    threadId: 'run-thread-1',
    generatedAt: '2026-11-18T12:00:00.000Z',
    thread: {
      id: 'run-thread-1',
      title: 'Task run thread',
      createdAt: '2026-11-18T09:00:00.000Z',
      updatedAt: '2026-11-18T09:05:00.000Z',
      forkedFromThreadId: null,
      forkedFromSeq: null,
      messages: [],
    },
    stats: {
      turnCount: 3,
      toolCallCount: 5,
      mostPopularTool: 'wiki_search',
      failureCount: 0,
      wikiWriteCount: 1,
      toolCallCounts: {},
      toolFailureCounts: {},
      otherFailures: {},
      toolInterruptCounts: {},
    },
    timeline: [],
    recursion: { recursionLimit: 100, recursionWarnThreshold: 0.75 },
    ...overrides,
  };
}

function runFixture(overrides: Partial<TaskRunRetrospective> = {}): TaskRunRetrospective {
  return {
    runId: 'run-1',
    runNumber: 1,
    status: 'done',
    summary: 'Labeled the inbox',
    recoveryAttempts: 0,
    threadReport: threadReportFixture(),
    ...overrides,
  };
}

function fixture(overrides: Partial<TaskRunReportData> = {}): TaskRunReportData {
  return {
    taskId: 'task-1',
    generatedAt: '2026-11-18T12:00:00.000Z',
    task: {
      id: 'task-1',
      title: 'Build labeler automation',
      status: 'done',
      origin: 'agent',
      provider: 'ollama',
      model: 'qwen3:14b',
      workspaceId: 'ws-1',
    },
    runs: [runFixture()],
    anomalies: [],
    handoff: null,
    progressEntries: [],
    summary: { runCount: 1, failureCount: 0, wikiWriteCount: 1, anomalyCount: 0 },
    runsToComplete: 1,
    ...overrides,
  };
}

describe('render/renderTaskRunReportHtml', () => {
  it('produces a well-formed, self-contained HTML document with the expected content', async () => {
    const html = await renderTaskRunReportHtml(fixture());

    expect(html).to.include('<!DOCTYPE html>');
    expect(html).to.include('<style>');
    expect(html).to.not.include('<link');

    expect(html).to.include('Build labeler automation');
    expect(html).to.include('/api/v1/threads/run-thread-1/report');
  });

  it('shows the runs-to-complete value when the task has reached done', async () => {
    const html = await renderTaskRunReportHtml(fixture({ runsToComplete: 3 }));
    expect(html).to.include('3');
  });

  it('shows "Not yet complete" when the task has not reached done', async () => {
    const html = await renderTaskRunReportHtml(fixture({ runsToComplete: null }));
    expect(html).to.include('Not yet complete');
  });

  it('renders each anomaly kind with its own message', async () => {
    const html = await renderTaskRunReportHtml(
      fixture({
        anomalies: [
          {
            kind: 'repeated_failures',
            taskId: 'task-1',
            taskTitle: 'Build labeler automation',
            attempts: 2,
            lastSummary: 'Hit a tool error twice',
          },
          {
            kind: 'wiki_mismatch',
            threadId: 'run-thread-1',
            pageTitle: 'Minecraft',
            pageKind: 'entity',
            actualWikiName: 'work',
            expectedWikiId: 'personal',
            at: '2026-11-18T10:00:00.000Z',
          },
          {
            kind: 'recursion_escalation',
            threadId: 'run-thread-1',
            taskId: 'task-1',
            escalationKind: 'recursion_limit_warning',
            question: 'Reached 75 LLM calls without a check-in opportunity.',
            at: '2026-11-18T10:05:00.000Z',
          },
        ],
      }),
    );

    expect(html).to.include('Repeated failures');
    expect(html).to.include('failed 2 times in a row');
    expect(html).to.include('Wiki mismatch');
    expect(html).to.include('<code>work</code>');
    expect(html).to.include('Recursion limit');
    expect(html).to.include('Reached 75 LLM calls without a check-in opportunity.');
  });

  it('shows the empty state when there are no anomalies and no runs', async () => {
    const html = await renderTaskRunReportHtml(fixture({ anomalies: [], runs: [] }));
    expect(html).to.include('No anomalies flagged.');
    expect(html).to.include('No runs recorded');
  });

  it('renders a Handoffs section only when the task has a handoff', async () => {
    const withoutHandoff = await renderTaskRunReportHtml(fixture({ handoff: null }));
    expect(withoutHandoff).to.not.include('<h2>Handoffs</h2>');

    const withHandoff = await renderTaskRunReportHtml(
      fixture({
        handoff: {
          taskId: 'task-1',
          taskTitle: 'Migrate config',
          count: 2,
          lastSummary: 'Stopped at the user’s request.',
        },
      }),
    );
    expect(withHandoff).to.include('<h2>Handoffs</h2>');
    expect(withHandoff).to.include('Stopped at the user’s request.');
  });
});
