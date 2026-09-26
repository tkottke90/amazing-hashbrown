import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { workspaceSkillsRouter } from './workspace-skills.route.js';
import { bootWorkspaceStore, WorkspaceStore } from '../../services/workspace-store.js';

interface SkillsResponse {
  skills: Array<{ name: string; source: string; overrides?: boolean }>;
}

// GET /api/v1/workspaces/:id/skills feeds the workspace chat slash menu:
// global skills plus the workspace's own .agents/skills, each labelled with
// where it came from so the UI can badge repo skills.
describe('routes/v1/workspace-skills.route — GET /api/v1/workspaces/:id/skills', () => {
  // Mounted with mergeParams under /:id/skills in the real app (see
  // workspaces.route.ts) — replicate that nesting so :id reaches the handler.
  const BASE_PATH = '/api/v1/workspaces/:id/skills';

  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;
  let workspaceId: string;

  before(async () => {
    ({ baseUrl, close } = await startTestServer(workspaceSkillsRouter, BASE_PATH));
  });

  after(async () => {
    await close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-skills-route-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    const location = join(dir, 'ws');
    const skillDir = join(location, '.agents', 'skills', 'repo-route-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: repo-route-skill\ndescription: Shipped by the repo\n---\nbody\n',
    );
    workspaceId = new WorkspaceStore(db).createWorkspace({ name: 'W', location }).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function url(id: string, query = ''): string {
    return baseUrl.replace(':id', id) + query;
  }

  it('lists the workspace repo skill labelled with source "repo" [orchestration]', async () => {
    const res = await fetch(url(workspaceId));
    expect(res.status).to.equal(200);
    const body = (await res.json()) as SkillsResponse;
    const repo = body.skills.find((s) => s.name === 'repo-route-skill');
    expect(repo, 'repo skill should be in the response').to.include({ source: 'repo' });
    expect(body.skills.every((s) => typeof s.source === 'string')).to.equal(true);
  });

  it('filters by the q query parameter [orchestration]', async () => {
    const res = await fetch(url(workspaceId, '?q=shipped%20by'));
    const body = (await res.json()) as SkillsResponse;
    expect(body.skills.map((s) => s.name)).to.deep.equal(['repo-route-skill']);
  });

  it('returns 404 for an unknown workspace [orchestration]', async () => {
    const res = await fetch(url('does-not-exist'));
    expect(res.status).to.equal(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).to.include('does-not-exist');
  });
});
