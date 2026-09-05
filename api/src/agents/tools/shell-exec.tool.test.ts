import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ShellExecSchema } from './shell-exec.tool.js';

describe('agents/tools/shell-exec', () => {
  describe('ShellExecSchema', () => {
    it('rejects a call with no reason field', () => {
      expect(() => ShellExecSchema.parse({ command: 'ls' })).to.throw();
    });

    it('rejects a call with an empty-string reason', () => {
      expect(() => ShellExecSchema.parse({ command: 'ls', reason: '' })).to.throw();
    });

    it('accepts a call with a non-empty reason', () => {
      expect(() => ShellExecSchema.parse({ command: 'ls', reason: 'list files' })).to.not.throw();
    });
  });
});
