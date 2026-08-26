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
import { makeCreateWorkspaceTool } from './create-workspace.tool.js';

const THREAD_ID = 'test-thread';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: { thread_id: THREAD_ID }, toolCallId: 'call-1' };
}

describe('agents/tools/create-workspace', () => {
  let store: WorkspaceStore;
  let registry: WikiRegistry;
  let dir: string;
  let workspaceDirs: string[];
  let sseEvents: ChatSSEEvent[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'create-workspace-tool-test-'));
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

  it('creates a workspace, emits resource_created, and clears activeGatedSkill', async () => {
    const tool = makeCreateWorkspaceTool(store, registry);

    const result = (await tool.invoke(
      { name: `My Workspace ${randomUUID()}`, goal: 'Ship the thing', git: true },
      invokeConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;

    const created = store.listWorkspaces()[0]!;
    workspaceDirs.push(created.location);
    expect(created.goal).to.equal('Ship the thing');
    expect(created.git).to.equal(true);

    expect(sseEvents).to.have.length(1);
    expect(sseEvents[0]).to.deep.include({
      type: 'resource_created',
      resourceType: 'workspace',
      goal: 'Ship the thing',
      location: created.location,
      workspaceId: created.id,
    });

    expect(result.update.activeGatedSkill).to.equal(null);
  });

  it('relays a 409 verbatim without emitting an SSE event, on a duplicate name', async () => {
    const tool = makeCreateWorkspaceTool(store, registry);
    const name = `Dup ${randomUUID()}`;

    const first = (await tool.invoke({ name }, invokeConfig())) as unknown as { update: unknown };
    const createdLocation = store.listWorkspaces()[0]!.location;
    workspaceDirs.push(createdLocation);
    expect(first.update, 'first call should succeed').to.not.equal(undefined);

    const result = await tool.invoke({ name }, invokeConfig());

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include(name);
    expect(sseEvents, 'no SSE event on the rejected attempt').to.have.length(1);
  });

  it('lists available domains and creates nothing when wikiId matches no domain', async () => {
    await registry.create({ id: 'homelab', domain: 'homelab stuff', tags: ['servers'] });
    const tool = makeCreateWorkspaceTool(store, registry);

    const result = await tool.invoke(
      { name: `My Workspace ${randomUUID()}`, wikiId: 'nonexistent' },
      invokeConfig(),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('homelab');
    expect(store.listWorkspaces()).to.have.length(0);
    expect(sseEvents).to.have.length(0);
  });

  it('resolves wikiId by matching a tag, not just the domain id', async () => {
    await registry.create({ id: 'homelab', domain: 'homelab stuff', tags: ['servers'] });
    const tool = makeCreateWorkspaceTool(store, registry);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await tool.invoke({ name: `My Workspace ${randomUUID()}`, wikiId: 'servers' }, invokeConfig());

    const created = store.listWorkspaces()[0]!;
    workspaceDirs.push(created.location);
    expect(created.wikiId).to.equal('homelab');
  });
});
