import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { makeFindFileTool } from './find-file.tool.js';

describe('agents/tools/find-file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'find-file-tool-test-'));
    mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), '');
    writeFileSync(join(dir, 'src', 'nested', 'b.ts'), '');
    writeFileSync(join(dir, 'README.md'), '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds files matching a recursive glob pattern', async () => {
    const tool = makeFindFileTool(dir);
    const result = (await tool.invoke({ pattern: '**/*.ts' })) as unknown as string;

    expect(result).to.include(join('src', 'a.ts'));
    expect(result).to.include(join('src', 'nested', 'b.ts'));
    expect(result).to.not.include('README.md');
  });

  it('returns a plain message when nothing matches', async () => {
    const tool = makeFindFileTool(dir);
    const result = (await tool.invoke({ pattern: '*.py' })) as unknown as string;

    expect(result).to.include('No files matched');
  });

  it('rejects a path-traversal attempt in the optional path argument', async () => {
    const tool = makeFindFileTool(dir);
    const result = (await tool.invoke({ pattern: '*', path: '../' })) as unknown as string;

    expect(result).to.include('Invalid file path');
  });

  it('scopes results to the given subdirectory', async () => {
    const tool = makeFindFileTool(dir);
    const result = (await tool.invoke({ pattern: '*.ts', path: 'src' })) as unknown as string;

    expect(result).to.include(join('src', 'a.ts'));
    expect(result).to.not.include(join('src', 'nested', 'b.ts'));
  });
});
