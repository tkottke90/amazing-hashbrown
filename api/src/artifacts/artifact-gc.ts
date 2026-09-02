import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { listArtifactMeta, deleteArtifact } from './artifact-store.js';

/**
 * Deletes any 'user-upload' artifact that was never referenced by a sent
 * message (referencedAt still null) and is older than the configured
 * grace period. 'agent-generated' artifacts are never touched — they're
 * referenced inline in the assistant's own message content immediately on
 * creation, a different lifecycle this has no opinion on.
 *
 * Returns the number of artifacts deleted (mainly for logging/tests).
 */
export async function sweepOrphanedArtifacts(now: Date = new Date()): Promise<number> {
  const graceMs = env.artifactGc.graceMs;
  const cutoff = now.getTime() - graceMs;

  const orphaned = listArtifactMeta().filter(
    (meta) =>
      meta.origin === 'user-upload' &&
      meta.referencedAt === null &&
      new Date(meta.createdAt).getTime() < cutoff,
  );

  let deleted = 0;
  for (const meta of orphaned) {
    if (await deleteArtifact(meta.id)) deleted++;
  }
  return deleted;
}

// This is the first `setInterval` anywhere in this codebase — there's no
// shutdown/clearInterval precedent to match, and no SIGTERM handling in
// index.ts at all today. Deliberately not adding shutdown scaffolding for
// just this one interval in v1: leaking it on process exit is harmless,
// and a bespoke cleanup path for a single timer would be inconsistent
// with a codebase that has no shutdown handling anywhere else.
export function startArtifactGc(): void {
  sweepOrphanedArtifacts().catch((err: unknown) => {
    logger.error('Artifact GC: initial sweep failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  });

  setInterval(() => {
    sweepOrphanedArtifacts().catch((err: unknown) => {
      logger.error('Artifact GC: sweep failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, env.artifactGc.intervalMs);
}
