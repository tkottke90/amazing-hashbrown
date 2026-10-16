import { describe, it } from 'mocha';
import { expect } from 'chai';
import { isValidDir, isSafeBasename, FILE_DIRS } from '../../src/internal/safe-path.js';

describe('safe-path', () => {
  describe('isValidDir', () => {
    it('accepts "scripts" and "references" [unit]', () => {
      expect(isValidDir('scripts')).to.equal(true);
      expect(isValidDir('references')).to.equal(true);
    });

    it('rejects "evals" — handled separately via loadEvals/saveEvals, not this generic path [unit]', () => {
      expect(isValidDir('evals')).to.equal(false);
    });

    it('rejects an arbitrary string [unit]', () => {
      expect(isValidDir('../etc')).to.equal(false);
      expect(isValidDir('')).to.equal(false);
    });

    it('FILE_DIRS is exactly scripts and references [unit]', () => {
      expect(FILE_DIRS).to.deep.equal(['scripts', 'references']);
    });
  });

  describe('isSafeBasename', () => {
    it('accepts an ordinary filename [unit]', () => {
      expect(isSafeBasename('note.txt')).to.equal(true);
      expect(isSafeBasename('script.py')).to.equal(true);
      expect(isSafeBasename('run_v2.js')).to.equal(true);
    });

    it('rejects an empty string [unit]', () => {
      expect(isSafeBasename('')).to.equal(false);
    });

    it('rejects a leading dot [unit]', () => {
      expect(isSafeBasename('.env')).to.equal(false);
    });

    it('rejects anything containing ".." even if the regex would otherwise allow it [unit]', () => {
      expect(isSafeBasename('a..b')).to.equal(false);
      expect(isSafeBasename('../etc/passwd')).to.equal(false);
    });

    it('rejects a path separator [unit]', () => {
      expect(isSafeBasename('dir/file.txt')).to.equal(false);
    });
  });
});
