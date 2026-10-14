import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ShellExecutorConfigSchema } from '../../src/config.js';

describe('ShellExecutorConfigSchema', () => {
  describe('denylist default', () => {
    it('seeds a non-empty default denylist when none is configured', () => {
      const denylist = ShellExecutorConfigSchema.parse({}).denylist;
      expect(denylist.length).to.be.greaterThan(0);
    });

    it('includes representative patterns from each destructive category', () => {
      const denylist = ShellExecutorConfigSchema.parse({}).denylist;
      expect(denylist).to.include.members([
        ':(){ :|:& };:',
        'rm -rf /',
        'mkfs.*',
        'chmod -R 777 /',
        'reboot',
        'curl * | sh*',
        'git push --force*',
        'git clean -fdx*',
      ]);
    });

    it('an explicitly configured denylist (even empty) overrides the seeded default', () => {
      expect(ShellExecutorConfigSchema.parse({ denylist: [] }).denylist).to.deep.equal([]);
    });
  });
});
