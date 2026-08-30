import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import type { LintReport, WikiRegistry } from '@tkottke90/llm-wiki';
import { createUploadJob, getUploadState } from '../../services/wiki-upload-store.js';
import { processUpload } from './wiki-upload.route.js';

describe('routes/v1/wiki-upload.route processUpload()', () => {
  let dir: string;
  let wikiRoot: string;
  let archivePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-upload-route-test-'));
    wikiRoot = join(dir, 'wiki');

    // Minimal, structurally-valid wiki source tree, tarred up — processUpload
    // shells out to `tar -xf`, so the fixture must round-trip through the
    // same extraction path it hits in production (a raw directory on disk
    // wouldn't exercise that step).
    const source = join(dir, 'source');
    mkdirSync(join(source, 'entities'), { recursive: true });
    writeFileSync(join(source, 'SCHEMA.md'), '# Schema\n');
    writeFileSync(join(source, 'index.md'), '# Index\n');
    writeFileSync(join(source, 'log.md'), '# Log\n');
    writeFileSync(join(source, 'entities', 'user.md'), '# User\n');

    archivePath = join(dir, 'wiki.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', source, '.']);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("threads each lint finding's file path through to the failed job state", async () => {
    const jobId = randomUUID();
    const wikiId = 'test-wiki';
    createUploadJob(jobId);

    const fakeReport: LintReport = {
      ok: false,
      checks: [
        {
          check: 'frontmatter',
          severity: 'error',
          page: 'entities/user.md',
          message: 'Missing or malformed required frontmatter: title.',
        },
      ],
    };
    // A plain fake satisfying only what the lint-failure path calls on it —
    // this repo has no mocking library and getWikiRegistry() is a real
    // singleton with no seam of its own, so processUpload's injectable
    // registry parameter is the way to keep this test off real disk/state.
    const fakeRegistry = {
      register: async () => undefined,
      lint: async () => fakeReport,
      remove: async () => undefined,
    } as unknown as WikiRegistry;

    await processUpload(jobId, wikiId, archivePath, fakeRegistry, wikiRoot);

    const state = getUploadState(jobId);
    expect(state?.stage, `expected job to fail, got: ${JSON.stringify(state)}`).to.equal('failed');
    if (!state || state.stage !== 'failed') return;
    expect(state.error).to.equal(
      'Wiki has 1 error-severity lint finding(s) — fix before uploading.',
    );
    expect(state.findings).to.have.length(1);
    expect(state.findings?.[0]).to.deep.equal(fakeReport.checks[0]);
  });
});
