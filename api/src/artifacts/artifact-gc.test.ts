import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import {
  bootArtifactStore,
  storeArtifact,
  getArtifactMeta,
  markArtifactReferenced,
  type ArtifactMeta,
} from './artifact-store.js';
import { sweepOrphanedArtifacts } from './artifact-gc.js';
import { env } from '../config/env.js';

function makeInput(overrides: Partial<Parameters<typeof storeArtifact>[0]> = {}) {
  return {
    mimeType: 'text/plain',
    original: Buffer.from('hi'),
    ...overrides,
  };
}

// Directly rewrites a stored artifact's on-disk meta.json createdAt, then
// reboots the store against the same directory to rehydrate it — same
// technique artifact-store.test.ts's "restart survival"/"boot resilience"
// blocks already use, since storeArtifact() itself always stamps "now".
async function backdateCreatedAt(dir: string, id: string, createdAt: Date): Promise<void> {
  const metaPath = join(dir, id, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ArtifactMeta;
  meta.createdAt = createdAt.toISOString();
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  await bootArtifactStore(dir);
}

describe('artifacts/artifact-gc', () => {
  describe('sweepOrphanedArtifacts()', () => {
    let dir: string;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'artifact-gc-test-'));
      await bootArtifactStore(dir);
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('leaves an unreferenced artifact just under the grace period alone', async () => {
      const id = await storeArtifact(makeInput());
      const now = new Date();
      const justUnderGrace = new Date(now.getTime() - env.artifactGc.graceMs + 60_000);
      await backdateCreatedAt(dir, id, justUnderGrace);

      const deleted = await sweepOrphanedArtifacts(now);
      expect(deleted).to.equal(0);
      expect(getArtifactMeta(id)).to.not.equal(undefined);
    });

    it('deletes an unreferenced artifact just over the grace period', async () => {
      const id = await storeArtifact(makeInput());
      const now = new Date();
      const justOverGrace = new Date(now.getTime() - env.artifactGc.graceMs - 60_000);
      await backdateCreatedAt(dir, id, justOverGrace);

      const deleted = await sweepOrphanedArtifacts(now);
      expect(deleted).to.equal(1);
      expect(getArtifactMeta(id)).to.equal(undefined);
    });

    it('never deletes a referenced artifact, regardless of age', async () => {
      const id = await storeArtifact(makeInput());
      const now = new Date();
      const wayOverGrace = new Date(now.getTime() - env.artifactGc.graceMs * 10);
      await backdateCreatedAt(dir, id, wayOverGrace);
      await markArtifactReferenced(id, wayOverGrace);

      const deleted = await sweepOrphanedArtifacts(now);
      expect(deleted).to.equal(0);
      expect(getArtifactMeta(id)).to.not.equal(undefined);
    });

    it('never deletes an agent-generated artifact, even when old and unreferenced', async () => {
      const id = await storeArtifact(makeInput({ origin: 'agent-generated' }));
      const now = new Date();
      const wayOverGrace = new Date(now.getTime() - env.artifactGc.graceMs * 10);
      await backdateCreatedAt(dir, id, wayOverGrace);

      const deleted = await sweepOrphanedArtifacts(now);
      expect(deleted).to.equal(0);
      expect(getArtifactMeta(id)).to.not.equal(undefined);
    });
  });
});
