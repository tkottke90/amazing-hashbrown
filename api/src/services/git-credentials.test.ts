import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildGitAuthArgs } from './git-credentials.js';

describe('services/git-credentials', () => {
  describe('buildGitAuthArgs()', () => {
    it('returns no args when no token is configured [unit]', () => {
      expect(buildGitAuthArgs(undefined)).to.deep.equal([]);
    });

    it('returns no args for an empty-string token [unit]', () => {
      expect(buildGitAuthArgs('')).to.deep.equal([]);
    });

    it('returns a -c extraHeader arg scoped to github.com when a token is set [unit]', () => {
      const args = buildGitAuthArgs('ghp_example_token');
      expect(args).to.have.length(2);
      expect(args[0]).to.equal('-c');
      expect(args[1]).to.match(/^http\.https:\/\/github\.com\/\.extraHeader=Authorization: Basic /);
    });

    it('encodes the token as Basic x-access-token:<token>, the GitHub-recommended PAT auth shape [unit]', () => {
      const [, header] = buildGitAuthArgs('ghp_example_token');
      const basic = header!.split('Basic ')[1]!;
      const decoded = Buffer.from(basic, 'base64').toString('utf8');
      expect(decoded).to.equal('x-access-token:ghp_example_token');
    });
  });
});
