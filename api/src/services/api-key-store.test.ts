import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ApiKeyStore } from './api-key-store.js';

describe('services/api-key-store', () => {
  let dir: string;
  let store: ApiKeyStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'api-key-store-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new ApiKeyStore(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('returns a non-empty secret once, prefixed for recognizability [unit]', () => {
      const created = store.create('Zapier');

      expect(created.key).to.be.a('string');
      expect(created.key.length).to.be.greaterThan(0);
      expect(created.key.startsWith('ahb_')).to.equal(true);
      expect(created.name).to.equal('Zapier');
      expect(created.id).to.be.a('string');
      expect(created.id.length).to.be.greaterThan(0);
    });

    it('lets the new secret verify successfully [unit]', () => {
      const created = store.create('Zapier');

      expect(store.verify(created.key)).to.equal(true);
    });
  });

  describe('list', () => {
    it('never exposes the secret or its hash [unit]', () => {
      store.create('Zapier');
      const [key] = store.list();

      expect(key).to.not.have.property('key');
      expect(key).to.not.have.property('keyHash');
      expect(key).to.not.have.property('key_hash');
    });

    it('returns every created key with id, name and timestamps [unit]', () => {
      store.create('Zapier');
      store.create('CI pipeline');

      const keys = store.list();

      expect(keys.map((k) => k.name)).to.have.members(['Zapier', 'CI pipeline']);
      for (const key of keys) {
        expect(key.id).to.be.a('string');
        expect(key.createdAt).to.be.a('string');
        expect(key.updatedAt).to.be.a('string');
      }
    });
  });

  describe('rotate', () => {
    it('invalidates the old secret and returns a working new one [unit]', () => {
      const created = store.create('Zapier');

      const rotated = store.rotate(created.id);

      expect(rotated).to.not.equal(null);
      expect(rotated!.key).to.not.equal(created.key);
      expect(store.verify(created.key)).to.equal(false);
      expect(store.verify(rotated!.key)).to.equal(true);
    });

    it('keeps the same id and name across rotation [unit]', () => {
      const created = store.create('Zapier');

      const rotated = store.rotate(created.id)!;

      expect(rotated.id).to.equal(created.id);
      expect(rotated.name).to.equal('Zapier');
    });

    it('returns null for an unknown id [unit]', () => {
      expect(store.rotate('does-not-exist')).to.equal(null);
    });
  });

  describe('revoke', () => {
    it('deletes the key so it no longer verifies or lists [unit]', () => {
      const created = store.create('Zapier');

      expect(store.revoke(created.id)).to.equal(true);

      expect(store.verify(created.key)).to.equal(false);
      expect(store.list()).to.have.lengthOf(0);
    });

    it('returns false for an unknown id [unit]', () => {
      expect(store.revoke('does-not-exist')).to.equal(false);
    });
  });

  describe('verify', () => {
    it('rejects a secret that was never issued [unit]', () => {
      expect(store.verify('ahb_garbage')).to.equal(false);
    });
  });
});
