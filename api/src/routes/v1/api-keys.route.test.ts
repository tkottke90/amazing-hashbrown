import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { apiKeysRouter } from './api-keys.route.js';
import { bootApiKeyStore } from '../../services/api-key-store.js';

describe('routes/v1/api-keys', () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ baseUrl, close } = await startTestServer(apiKeysRouter, '/api/v1/api-keys'));
  });

  after(async () => {
    await close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'api-keys-route-test-'));
    bootApiKeyStore(openDatabase(join(dir, 'test.db')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function post(path: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('creates a key and returns its secret once [orchestration]', async () => {
    const res = await post('/', { name: 'Zapier' });

    expect(res.status).to.equal(201);
    const body = await res.json();
    expect(body.name).to.equal('Zapier');
    expect(body.key).to.be.a('string');
    expect(body.key.length).to.be.greaterThan(0);
  });

  it('rejects creation with a missing name [orchestration]', async () => {
    const res = await post('/', {});
    expect(res.status).to.equal(400);
  });

  it('lists created keys without ever exposing a secret or hash [orchestration]', async () => {
    await post('/', { name: 'Zapier' });
    await post('/', { name: 'CI pipeline' });

    const res = await fetch(`${baseUrl}/`);
    const keys = await res.json();

    expect(res.status).to.equal(200);
    expect(keys.map((k: { name: string }) => k.name)).to.have.members(['Zapier', 'CI pipeline']);
    for (const key of keys) {
      expect(key).to.not.have.property('key');
      expect(key).to.not.have.property('keyHash');
    }
  });

  it('rotates a key to a new secret, keeping its id and name [orchestration]', async () => {
    const created = await (await post('/', { name: 'Zapier' })).json();

    const res = await post(`/${created.id}/rotate`);
    const rotated = await res.json();

    expect(res.status).to.equal(200);
    expect(rotated.id).to.equal(created.id);
    expect(rotated.name).to.equal('Zapier');
    expect(rotated.key).to.be.a('string').and.not.equal(created.key);
  });

  it('404s rotating an unknown key [orchestration]', async () => {
    const res = await post('/does-not-exist/rotate');
    expect(res.status).to.equal(404);
  });

  it('revokes a key, which then disappears from the list [orchestration]', async () => {
    const created = await (await post('/', { name: 'Zapier' })).json();

    const res = await fetch(`${baseUrl}/${created.id}`, { method: 'DELETE' });
    expect(res.status).to.equal(204);

    const keys = await (await fetch(`${baseUrl}/`)).json();
    expect(keys).to.have.lengthOf(0);
  });

  it('404s revoking an unknown key [orchestration]', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`, { method: 'DELETE' });
    expect(res.status).to.equal(404);
  });
});
