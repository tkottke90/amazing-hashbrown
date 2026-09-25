import { describe, it } from 'mocha';
import { expect } from 'chai';
import { toWorkspaceResponse } from './workspace-response.js';

describe('routes/v1/workspace-response', () => {
  describe('toWorkspaceResponse()', () => {
    const roots = ['/data/projects', '/tmp/projects'];

    it('flags a workspace under a managed root as managed [unit]', () => {
      const result = toWorkspaceResponse({ id: 'a', location: '/data/projects/foo' }, roots);
      expect(result.managedLocation).to.equal(true);
    });

    it('flags a legacy free-form location as unmanaged [unit]', () => {
      const result = toWorkspaceResponse({ id: 'a', location: '/home/me/code/repo' }, roots);
      expect(result.managedLocation).to.equal(false);
    });

    it('preserves every other field, including nested project data [unit]', () => {
      const input = { id: 'a', name: 'Foo', location: '/tmp/projects/foo', project: { id: 'a' } };
      expect(toWorkspaceResponse(input, roots)).to.deep.equal({ ...input, managedLocation: true });
    });
  });
});
