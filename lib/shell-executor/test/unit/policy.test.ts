import { describe, it } from 'mocha';
import { expect } from 'chai';
import { evaluatePolicy } from '../../src/policy.js';

describe('evaluatePolicy', () => {
  it('returns requires-approval when both lists are empty', () => {
    expect(evaluatePolicy('ls -la', { allowlist: [], denylist: [] })).to.equal('requires-approval');
  });

  it('returns allowed for an exact allowlist match', () => {
    expect(evaluatePolicy('ls', { allowlist: ['ls'], denylist: [] })).to.equal('allowed');
  });

  it('returns denied for an exact denylist match', () => {
    expect(evaluatePolicy('rm -rf /', { allowlist: [], denylist: ['rm -rf /'] })).to.equal(
      'denied',
    );
  });

  it('returns allowed for a glob allowlist match (prefix pattern)', () => {
    expect(evaluatePolicy('git status', { allowlist: ['git *'], denylist: [] })).to.equal(
      'allowed',
    );
  });

  it('denylist wins over allowlist when both match', () => {
    expect(evaluatePolicy('git push', { allowlist: ['git *'], denylist: ['git push'] })).to.equal(
      'denied',
    );
  });

  it('exact match does not match a longer command (anchoring)', () => {
    expect(evaluatePolicy('git status', { allowlist: ['git'], denylist: [] })).to.equal(
      'requires-approval',
    );
  });

  it('glob with * matches commands with multiple words', () => {
    expect(evaluatePolicy('echo hello world', { allowlist: ['echo *'], denylist: [] })).to.equal(
      'allowed',
    );
  });

  it('returns requires-approval when command does not match any pattern', () => {
    expect(
      evaluatePolicy('curl https://example.com', {
        allowlist: ['ls', 'git *'],
        denylist: ['rm *'],
      }),
    ).to.equal('requires-approval');
  });

  it('denylist glob matches prefix', () => {
    expect(evaluatePolicy('rm -rf /', { allowlist: [], denylist: ['rm *'] })).to.equal('denied');
  });

  it('dots in patterns are treated as literals', () => {
    expect(evaluatePolicy('ls.txt', { allowlist: ['ls*txt'], denylist: [] })).to.equal('allowed');
    expect(evaluatePolicy('ls_txt', { allowlist: ['ls.txt'], denylist: [] })).to.equal(
      'requires-approval',
    );
  });

  // Default denylist categories (lib/shell-executor/src/config.ts) — one
  // match and one clear non-match per category, against evaluatePolicy
  // directly rather than the schema default.
  describe('default denylist categories', () => {
    const denylist = [
      ':(){ :|:& };:',
      'rm -rf /',
      'rm -rf /*',
      'rm -rf ~',
      'mkfs.*',
      'dd *of=/dev/*',
      'wipefs *',
      'shred *',
      'fdisk /dev/*',
      'parted /dev/* rm*',
      'chmod -R 777 /',
      'chmod -R 777 /*',
      'chown -R * /',
      'reboot',
      'shutdown *',
      'halt',
      'poweroff',
      'init 0',
      'curl * | sh*',
      'curl * | bash*',
      'wget * -O- | sh*',
      'git push --force*',
      'git push -f*',
      'git clean -fdx*',
      'git clean -fd*',
    ];

    it('denies a fork bomb', () => {
      expect(evaluatePolicy(':(){ :|:& };:', { allowlist: [], denylist })).to.equal('denied');
    });

    it('denies unscoped rm -rf but not a scoped one', () => {
      expect(evaluatePolicy('rm -rf /', { allowlist: [], denylist })).to.equal('denied');
      expect(evaluatePolicy('rm -rf ./node_modules', { allowlist: [], denylist })).to.equal(
        'requires-approval',
      );
    });

    it('denies disk/block-device operations but not an unrelated dd use', () => {
      expect(evaluatePolicy('dd if=/dev/zero of=/dev/sda', { allowlist: [], denylist })).to.equal(
        'denied',
      );
      expect(
        evaluatePolicy('dd if=/dev/zero of=./scratch.img', { allowlist: [], denylist }),
      ).to.equal('requires-approval');
    });

    it('denies blast-wide chmod/chown but not a scoped one', () => {
      expect(evaluatePolicy('chmod -R 777 /', { allowlist: [], denylist })).to.equal('denied');
      expect(evaluatePolicy('chmod -R 755 ./dist', { allowlist: [], denylist })).to.equal(
        'requires-approval',
      );
    });

    it('denies host/container shutdown commands but not an unrelated one', () => {
      expect(evaluatePolicy('reboot', { allowlist: [], denylist })).to.equal('denied');
      expect(evaluatePolicy('shutdown -c', { allowlist: [], denylist })).to.equal('denied');
      expect(evaluatePolicy('echo reboot', { allowlist: [], denylist })).to.equal(
        'requires-approval',
      );
    });

    it('denies piping a remote fetch into a shell but not a plain download', () => {
      expect(
        evaluatePolicy('curl https://example.com/install.sh | sh', { allowlist: [], denylist }),
      ).to.equal('denied');
      expect(
        evaluatePolicy('curl https://example.com/file -o file', { allowlist: [], denylist }),
      ).to.equal('requires-approval');
    });

    it('denies a force-push but not a plain push', () => {
      expect(evaluatePolicy('git push --force origin main', { allowlist: [], denylist })).to.equal(
        'denied',
      );
      expect(evaluatePolicy('git push origin main', { allowlist: [], denylist })).to.equal(
        'requires-approval',
      );
    });

    it('denies git clean -fd but not git status', () => {
      expect(evaluatePolicy('git clean -fdx', { allowlist: [], denylist })).to.equal('denied');
      expect(evaluatePolicy('git status', { allowlist: [], denylist })).to.equal(
        'requires-approval',
      );
    });
  });
});
