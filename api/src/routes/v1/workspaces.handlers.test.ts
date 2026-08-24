import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { createWorkspaceHandler } from './workspaces.handlers.js';

describe('routes/v1/workspaces.handlers', () => {
  describe('createWorkspaceHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspaces-handlers-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns 400 when name is missing', async () => {
      const result = await createWorkspaceHandler(store, {
        locationRoot: 'projects',
        directoryName: 'my-workspace',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 400 when locationRoot is missing', async () => {
      const result = await createWorkspaceHandler(store, {
        name: 'My Workspace',
        directoryName: 'my-workspace',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('locationRoot');
      }
    });

    it('returns 400 when locationRoot is not "projects" or "temporary"', async () => {
      const result = await createWorkspaceHandler(store, {
        name: 'My Workspace',
        locationRoot: 'somewhere-else',
        directoryName: 'my-workspace',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 400 when directoryName is missing', async () => {
      const result = await createWorkspaceHandler(store, {
        name: 'My Workspace',
        locationRoot: 'projects',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('directoryName');
      }
    });

    it('returns 400 when directoryName is a path traversal attempt', async () => {
      const result = await createWorkspaceHandler(store, {
        name: 'My Workspace',
        locationRoot: 'projects',
        directoryName: '../../etc',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('Invalid directoryName');
      }
    });
  });
});
