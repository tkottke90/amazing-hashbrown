import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { makeEditFileTool } from './edit-file.tool.js';

describe('agents/tools/edit-file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edit-file-tool-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces a uniquely-matching string', async () => {
    writeFileSync(join(dir, 'a.txt'), 'const x = 1;\n');
    const tool = makeEditFileTool(dir);

    const result = (await tool.invoke({
      path: 'a.txt',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    })) as unknown as string;

    expect(result).to.include('Replaced 1 occurrence');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).to.equal('const x = 2;\n');
  });

  it('rejects and makes no changes when old_string does not match', async () => {
    writeFileSync(join(dir, 'a.txt'), 'const x = 1;\n');
    const tool = makeEditFileTool(dir);

    const result = (await tool.invoke({
      path: 'a.txt',
      old_string: 'const y = 1;',
      new_string: 'const y = 2;',
    })) as unknown as string;

    expect(result).to.include('was not found');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).to.equal('const x = 1;\n');
  });

  it('rejects and makes no changes when old_string matches more than once', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x\nx\n');
    const tool = makeEditFileTool(dir);

    const result = (await tool.invoke({
      path: 'a.txt',
      old_string: 'x',
      new_string: 'y',
    })) as unknown as string;

    expect(result).to.include('matches 2 locations');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).to.equal('x\nx\n');
  });

  it('rejects a path-traversal attempt', async () => {
    const tool = makeEditFileTool(dir);
    const result = (await tool.invoke({
      path: '../outside.txt',
      old_string: 'a',
      new_string: 'b',
    })) as unknown as string;

    expect(result).to.include('Invalid file path');
  });
});
