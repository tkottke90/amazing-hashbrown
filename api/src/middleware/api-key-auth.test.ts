import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Router } from 'express';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { bootApiKeyStore, getApiKeyStore } from '../services/api-key-store.js';
import { apiKeyAuth } from './api-key-auth.js';

describe('middleware/api-key-auth', () => {
  let server: { baseUrl: string; close: () => Promise<void> };

  before(async () => {
    const router = Router();
    router.get('/protected', apiKeyAuth, (_req, res) => {
      res.json({ ok: true });
    });
    server = await startTestServer(router, '/test');
  });

  after(async () => {
    await server.close();
  });

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'api-key-auth-test-'));
    bootApiKeyStore(openDatabase(join(dir, 'test.db')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a request with no Authorization header [unit]', async () => {
    const res = await fetch(`${server.baseUrl}/protected`);
    expect(res.status).to.equal(401);
    expect(await res.json()).to.deep.equal({ error: 'Invalid or missing API key' });
  });

  it('rejects a malformed Authorization header (no Bearer prefix) [unit]', async () => {
    const res = await fetch(`${server.baseUrl}/protected`, {
      headers: { Authorization: 'not-a-bearer-token' },
    });
    expect(res.status).to.equal(401);
  });

  it('rejects an unknown bearer token [unit]', async () => {
    const res = await fetch(`${server.baseUrl}/protected`, {
      headers: { Authorization: 'Bearer ahb_doesnotexist' },
    });
    expect(res.status).to.equal(401);
  });

  it('lets a request through with a valid bearer token [unit]', async () => {
    const { key } = getApiKeyStore().create('test');

    const res = await fetch(`${server.baseUrl}/protected`, {
      headers: { Authorization: `Bearer ${key}` },
    });

    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({ ok: true });
  });

  it('rejects a token immediately after it is revoked [unit]', async () => {
    const { id, key } = getApiKeyStore().create('test');
    getApiKeyStore().revoke(id);

    const res = await fetch(`${server.baseUrl}/protected`, {
      headers: { Authorization: `Bearer ${key}` },
    });

    expect(res.status).to.equal(401);
  });
});
