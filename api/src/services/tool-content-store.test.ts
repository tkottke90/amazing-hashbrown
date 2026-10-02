import { expect } from 'chai';
import {
  storeToolContent,
  getToolContent,
  storeBinaryToolContent,
  getToolContentEntry,
} from './tool-content-store.js';

describe('tool-content-store', () => {
  it('round-trips text content through storeToolContent/getToolContent [unit]', () => {
    storeToolContent('thread-a', 'key-1', 'hello world');

    expect(getToolContent('thread-a', 'key-1')).to.equal('hello world');
  });

  it('getToolContent returns undefined for a key stored as binary [unit]', () => {
    storeBinaryToolContent('thread-b', 'key-2', 'artifact-1');

    expect(getToolContent('thread-b', 'key-2')).to.equal(undefined);
  });

  it('round-trips a binary entry through storeBinaryToolContent/getToolContentEntry [unit]', () => {
    storeBinaryToolContent('thread-c', 'key-3', 'artifact-2');

    expect(getToolContentEntry('thread-c', 'key-3')).to.deep.equal({
      kind: 'binary',
      attachmentId: 'artifact-2',
    });
  });

  it('getToolContentEntry returns a text-kind entry for a text-stored key [unit]', () => {
    storeToolContent('thread-d', 'key-4', 'some text');

    expect(getToolContentEntry('thread-d', 'key-4')).to.deep.equal({
      kind: 'text',
      content: 'some text',
    });
  });

  it('getToolContentEntry returns undefined for an unknown threadId/toolKey pair [unit]', () => {
    expect(getToolContentEntry('thread-does-not-exist', 'key-does-not-exist')).to.equal(undefined);
  });

  it('isolates the same toolKey stored under two different threadIds [unit]', () => {
    storeToolContent('thread-e', 'shared-key', 'content for thread e');
    storeBinaryToolContent('thread-f', 'shared-key', 'artifact-for-thread-f');

    expect(getToolContent('thread-e', 'shared-key')).to.equal('content for thread e');
    expect(getToolContentEntry('thread-f', 'shared-key')).to.deep.equal({
      kind: 'binary',
      attachmentId: 'artifact-for-thread-f',
    });
  });
});
