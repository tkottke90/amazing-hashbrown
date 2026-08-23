import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { createProjectHandler } from './projects.handlers.js';

describe('routes/v1/projects.handlers', () => {
  describe('createProjectHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'projects-handlers-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns 400 when locationRoot is missing', async () => {
      const result = await createProjectHandler(store, {
        name: 'My Project',
        directoryName: 'my-project',
        winCondition: 'It ships',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('locationRoot');
      }
    });

    it('returns 400 when directoryName is missing', async () => {
      const result = await createProjectHandler(store, {
        name: 'My Project',
        locationRoot: 'projects',
        winCondition: 'It ships',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('directoryName');
      }
    });

    it('returns 400 when directoryName is a path traversal attempt', async () => {
      const result = await createProjectHandler(store, {
        name: 'My Project',
        locationRoot: 'projects',
        directoryName: '../../etc',
        winCondition: 'It ships',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('Invalid directoryName');
      }
    });

    it('still returns 400 when winCondition is missing (pre-existing check, unaffected)', async () => {
      const result = await createProjectHandler(store, {
        name: 'My Project',
        locationRoot: 'projects',
        directoryName: 'my-project',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('winCondition');
      }
    });
  });
});
