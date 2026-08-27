import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { setActiveSseWriter, clearActiveSseWriter } from '../active-sse-writer.js';
import { makeCreateProjectTool } from './create-project.tool.js';

const THREAD_ID = 'test-thread';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: { thread_id: THREAD_ID }, toolCallId: 'call-1' };
}

describe('agents/tools/create-project', () => {
  let store: WorkspaceStore;
  let registry: WikiRegistry;
  let dir: string;
  let workspaceDirs: string[];
  let sseEvents: ChatSSEEvent[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'create-project-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    workspaceDirs = [];
    sseEvents = [];
    setActiveSseWriter(THREAD_ID, (event) => sseEvents.push(event));
  });

  afterEach(() => {
    clearActiveSseWriter(THREAD_ID);
    rmSync(dir, { recursive: true, force: true });
    for (const wsDir of workspaceDirs) rmSync(wsDir, { recursive: true, force: true });
  });

  it('creates a project with an ephemeral wiki and emits resource_created', async () => {
    const tool = makeCreateProjectTool(store, registry);

    const result = (await tool.invoke(
      { name: `My Project ${randomUUID()}`, winCondition: 'It ships' },
      invokeConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;

    const created = store.listProjects()[0]!;
    workspaceDirs.push(created.location);
    expect(created.project.winCondition).to.equal('It ships');
    expect(created.wikiId).to.equal(`project-${created.id}`);
    expect(registry.list().map((d) => d.id)).to.deep.equal([`project-${created.id}`]);

    expect(sseEvents).to.have.length(1);
    expect(sseEvents[0]).to.deep.include({
      type: 'resource_created',
      resourceType: 'project',
      location: created.location,
      workspaceId: created.id,
    });

    expect(result.update.activeGatedSkill).to.equal(null);
  });

  it('relays a 409 verbatim without emitting an SSE event, on a duplicate name', async () => {
    const tool = makeCreateProjectTool(store, registry);
    const name = `Dup Project ${randomUUID()}`;

    const first = (await tool.invoke(
      { name, winCondition: 'It ships' },
      invokeConfig(),
    )) as unknown as { update: unknown };
    workspaceDirs.push(store.listProjects()[0]!.location);
    expect(first.update, 'first call should succeed').to.not.equal(undefined);

    const result = await tool.invoke({ name, winCondition: 'It ships' }, invokeConfig());

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include(name);
    expect(sseEvents, 'no SSE event on the rejected attempt').to.have.length(1);
    // No orphaned ephemeral wiki from the rejected second attempt.
    expect(registry.list()).to.have.length(1);
  });
});
