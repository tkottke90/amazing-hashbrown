import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { ThreadStore } from '../../services/thread-store.js';
import { bootObservability } from '../../services/observability.js';
import { configManager } from '../../config/env.js';
import { generateWorkspaceRetrospectiveHandler } from './workspace-retrospective.handlers.js';

enum TestTypes {
  UNIT = '[unit]',
  ORCHESTRATION = '[orchestration]',
}

describe('routes/v1/workspace-retrospective.handlers', () => {
  let workspaceStore: WorkspaceStore;
  let threadStore: ThreadStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-retrospective-handlers-test-'));
    workspaceStore = new WorkspaceStore(openDatabase(join(dir, 'workspaces.db')));
    threadStore = new ThreadStore(openDatabase(join(dir, 'threads.db')));
    bootObservability(openDatabase(join(dir, 'observability.db')));
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(`returns 404 when the workspace does not exist ${TestTypes.UNIT}`, async () => {
    const result = await generateWorkspaceRetrospectiveHandler(
      { workspaceStore, threadStore },
      'missing',
      { narrative: false },
    );
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(404);
  });

  it(`renders the deterministic report for a workspace with tasks, without needing a model ${TestTypes.ORCHESTRATION}`, async () => {
    const location = mkdtempSync(join(dir, 'ws-'));
    const ws = workspaceStore.createWorkspace({
      name: 'Gmail Labeler',
      location,
      goal: 'Label mail',
    });
    const task = workspaceStore.createTask({
      title: 'Build the labeler automation',
      workspaceId: ws.id,
    });
    workspaceStore.enqueueTask(task.id);

    const result = await generateWorkspaceRetrospectiveHandler(
      { workspaceStore, threadStore },
      ws.id,
      { narrative: false },
    );

    expect(result.ok).to.equal(true);
    if (!result.ok) return;
    expect(result.data.html).to.include('Gmail Labeler');
    expect(result.data.html).to.include('Build the labeler automation');
    expect(result.data.html).to.not.include('What happened, and why');
  });

  it(`degrades gracefully to no narrative when no model provider is configured, rather than failing the request ${TestTypes.ORCHESTRATION}`, async () => {
    const location = mkdtempSync(join(dir, 'ws-'));
    const ws = workspaceStore.createWorkspace({ name: 'Gmail Labeler', location });

    // No providers configured (see beforeEach) — createProvider() inside the
    // handler's narrative branch should throw, be caught, and leave the
    // report otherwise intact.
    const result = await generateWorkspaceRetrospectiveHandler(
      { workspaceStore, threadStore },
      ws.id,
      {},
    );

    expect(result.ok).to.equal(true);
    if (!result.ok) return;
    expect(result.data.html).to.include('Gmail Labeler');
    expect(result.data.html).to.not.include('What happened, and why');
  });
});
