import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { ThreadReportData } from '@tkottke90/thread-reports';
import { renderWorkspaceRetrospectiveHtml } from '../../src/render.js';
import type { WorkspaceRetrospectiveData } from '../../src/types.js';

function chatFixture(): ThreadReportData {
  return {
    threadId: 'chat-thread',
    generatedAt: '2026-07-18T12:00:00.000Z',
    thread: {
      id: 'chat-thread',
      title: 'Gmail Labeler workspace chat',
      createdAt: '2026-07-18T09:00:00.000Z',
      updatedAt: '2026-07-18T09:05:00.000Z',
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
    },
    timeline: [],
    recursion: { recursionLimit: 100, recursionWarnThreshold: 0.75 },
  };
}

function fixture(overrides: Partial<WorkspaceRetrospectiveData> = {}): WorkspaceRetrospectiveData {
  return {
    workspaceId: 'ws-1',
    generatedAt: '2026-07-18T12:00:00.000Z',
    workspace: {
      id: 'ws-1',
      name: 'Gmail Labeler',
      goal: 'Automatically label incoming Gmail messages',
      wikiId: 'personal',
      threadId: 'chat-thread',
      createdAt: '2026-07-18T08:00:00.000Z',
    },
    chat: chatFixture(),
    tasks: [],
    anomalies: [],
    handoffs: [],
    summary: {
      taskCount: 0,
      runCount: 0,
      failureCount: 0,
      wikiWriteCount: 1,
      anomalyCount: 0,
      handoffCount: 0,
    },
    narrative: null,
    ...overrides,
  };
}

describe('render/renderWorkspaceRetrospectiveHtml', () => {
  it('produces a well-formed, self-contained HTML document with the expected content', async () => {
    const html = await renderWorkspaceRetrospectiveHtml(fixture());

    expect(html).to.include('<!DOCTYPE html>');
    expect(html).to.include('<style>');
    expect(html).to.not.include('<link');
    expect(html).to.not.include('http://');
    expect(html).to.not.include('https://');

    expect(html).to.include('Gmail Labeler');
    expect(html).to.include('Automatically label incoming Gmail messages');
    expect(html).to.include('/api/v1/threads/chat-thread/report');
  });

  it('renders the narrative box only when narrative is set', async () => {
    const withNarrative = await renderWorkspaceRetrospectiveHtml(
      fixture({ narrative: 'The agent **struggled** with the recursion limit.' }),
    );
    expect(withNarrative).to.include('What happened, and why');
    expect(withNarrative).to.include('<strong>struggled</strong>');

    const withoutNarrative = await renderWorkspaceRetrospectiveHtml(fixture({ narrative: null }));
    expect(withoutNarrative).to.not.include('What happened, and why');
  });

  it('renders each anomaly kind with its own message', async () => {
    const html = await renderWorkspaceRetrospectiveHtml(
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
            threadId: 'chat-thread',
            pageTitle: 'Minecraft',
            pageKind: 'entity',
            actualWikiName: 'work',
            expectedWikiId: 'personal',
            at: '2026-07-18T10:00:00.000Z',
          },
          {
            kind: 'recursion_escalation',
            threadId: 'run-thread-1',
            taskId: 'task-1',
            escalationKind: 'recursion_limit_warning',
            question: 'Reached 75 LLM calls without a check-in opportunity.',
            at: '2026-07-18T10:05:00.000Z',
          },
        ],
      }),
    );

    expect(html).to.include('Repeated failures');
    expect(html).to.include('Build labeler automation');
    expect(html).to.include('failed 2 times in a row');
    expect(html).to.include('Wiki mismatch');
    expect(html).to.include('<code>work</code>');
    expect(html).to.include('Recursion limit');
    expect(html).to.include('Reached 75 LLM calls without a check-in opportunity.');
  });

  it("shows a workspace's empty states when it has no chat thread or tasks", async () => {
    const html = await renderWorkspaceRetrospectiveHtml(fixture({ chat: null, tasks: [] }));
    expect(html).to.include('This workspace has no chat thread.');
    expect(html).to.include('No tasks were created in this workspace.');
  });

  it('renders a Handoffs section only when there are handoffs, separate from Anomalies (issue #364)', async () => {
    const withoutHandoffs = await renderWorkspaceRetrospectiveHtml(fixture());
    expect(withoutHandoffs).to.not.include('<h2>Handoffs</h2>');

    const withHandoffs = await renderWorkspaceRetrospectiveHtml(
      fixture({
        handoffs: [
          {
            taskId: 'task-1',
            taskTitle: 'Migrate config',
            count: 2,
            lastSummary: 'Stopped at the user’s request.',
          },
        ],
        summary: {
          taskCount: 1,
          runCount: 2,
          failureCount: 0,
          wikiWriteCount: 1,
          anomalyCount: 0,
          handoffCount: 2,
        },
      }),
    );
    expect(withHandoffs).to.include('<h2>Handoffs</h2>');
    expect(withHandoffs).to.include('Migrate config');
    expect(withHandoffs).to.include('Stopped at the user’s request.');
  });
});
