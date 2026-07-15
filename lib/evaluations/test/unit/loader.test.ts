import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import { loadSuites, loadSuite } from '../../src/loader.js';

const VALID_SUITE_YAML = `
suite:
  id: test-suite
  name: Test Suite
  purpose: Testing the loader
  passingThreshold: 0.8

scenarios:
  - id: sc-1
    name: Scenario 1
    purpose: Tests basic detection
    type: deterministic
    input: "Hello"
    match: contains
    expected: "hello"
`;

const ANOTHER_SUITE_YAML = `
suite:
  id: another-suite
  name: Another Suite
  purpose: A second suite

scenarios:
  - id: sc-2
    name: Scenario 2
    purpose: Tests another thing
    type: deterministic
    input: "World"
    match: exact
    expected: "world"
`;

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'eval-loader-test-'));
}

describe('loadSuites', () => {
  it('loads a valid suite from bundledPath', async () => {
    const dir = createTempDir();
    try {
      writeFileSync(join(dir, 'test-suite.yaml'), VALID_SUITE_YAML);
      const map = await loadSuites({ bundledPath: dir });
      assert.ok(map.has('test-suite'));
      const suite = map.get('test-suite')!;
      assert.equal(suite.suite.name, 'Test Suite');
      assert.equal(suite.scenarios.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty map when bundledPath does not exist', async () => {
    const map = await loadSuites({ bundledPath: '/nonexistent/path' });
    assert.equal(map.size, 0);
  });

  it('userPath shadows bundledPath when suite ids match', async () => {
    const bundledDir = createTempDir();
    const userDir = createTempDir();
    try {
      writeFileSync(join(bundledDir, 'test-suite.yaml'), VALID_SUITE_YAML);
      writeFileSync(join(userDir, 'test-suite.yaml'), VALID_SUITE_YAML.replace('Test Suite', 'User Suite'));

      const map = await loadSuites({ bundledPath: bundledDir, userPath: userDir });
      assert.equal(map.size, 1);
      assert.equal(map.get('test-suite')?.suite.name, 'User Suite');
    } finally {
      rmSync(bundledDir, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  it('loads multiple suites from same directory', async () => {
    const dir = createTempDir();
    try {
      writeFileSync(join(dir, 'suite-a.yaml'), VALID_SUITE_YAML);
      writeFileSync(join(dir, 'suite-b.yaml'), ANOTHER_SUITE_YAML);
      const map = await loadSuites({ bundledPath: dir });
      assert.equal(map.size, 2);
      assert.ok(map.has('test-suite'));
      assert.ok(map.has('another-suite'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on invalid YAML syntax', async () => {
    const dir = createTempDir();
    try {
      writeFileSync(join(dir, 'bad.yaml'), 'suite: [unclosed bracket');
      await assert.rejects(() => loadSuites({ bundledPath: dir }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when suite fails schema validation', async () => {
    const dir = createTempDir();
    try {
      writeFileSync(join(dir, 'invalid.yaml'), 'suite:\n  id: no-name\n  purpose: p\nscenarios: []\n');
      await assert.rejects(() => loadSuites({ bundledPath: dir }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadSuite', () => {
  it('returns suite by id', async () => {
    const dir = createTempDir();
    try {
      writeFileSync(join(dir, 'test-suite.yaml'), VALID_SUITE_YAML);
      const suite = await loadSuite('test-suite', { bundledPath: dir });
      assert.ok(suite);
      assert.equal(suite.suite.id, 'test-suite');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when suite id not found', async () => {
    const dir = createTempDir();
    try {
      writeFileSync(join(dir, 'test-suite.yaml'), VALID_SUITE_YAML);
      const suite = await loadSuite('missing-suite', { bundledPath: dir });
      assert.equal(suite, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
