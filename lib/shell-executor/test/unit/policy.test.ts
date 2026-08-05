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
    expect(evaluatePolicy('rm -rf /', { allowlist: [], denylist: ['rm -rf /'] })).to.equal('denied');
  });

  it('returns allowed for a glob allowlist match (prefix pattern)', () => {
    expect(evaluatePolicy('git status', { allowlist: ['git *'], denylist: [] })).to.equal('allowed');
  });

  it('denylist wins over allowlist when both match', () => {
    expect(
      evaluatePolicy('git push', { allowlist: ['git *'], denylist: ['git push'] }),
    ).to.equal('denied');
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
      evaluatePolicy('curl https://example.com', { allowlist: ['ls', 'git *'], denylist: ['rm *'] }),
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
});
