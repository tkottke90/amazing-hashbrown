import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { makeReadFileTool } from './read-file.tool.js';

describe('agents/tools/read-file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'read-file-tool-test-'));
    writeFileSync(join(dir, 'notes.txt'), 'hello workspace');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the full file contents', async () => {
    const tool = makeReadFileTool(dir);
    const result = (await tool.invoke({ path: 'notes.txt' })) as unknown as string;

    expect(result).to.equal('hello workspace');
  });

  it('returns a plain error for a missing file', async () => {
    const tool = makeReadFileTool(dir);
    const result = (await tool.invoke({ path: 'missing.txt' })) as unknown as string;

    expect(result).to.include('Could not read');
  });

  it('rejects a path-traversal attempt', async () => {
    const tool = makeReadFileTool(dir);
    const result = (await tool.invoke({ path: '../outside.txt' })) as unknown as string;

    expect(result).to.include('Invalid file path');
  });
});
