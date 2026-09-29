import { newWikiNameError, wikiIdFromName } from '@/pages/workspaces/new-wiki-name-field';

describe('newWikiNameError [unit]', () => {
  it('rejects a name with no letters or numbers, since it would produce an empty id', () => {
    expect(newWikiNameError('!!!', [])).toBe('Wiki name must contain letters or numbers.');
  });

  it('rejects a name whose derived id is already taken', () => {
    // Compared on the derived id, not the raw text — "Video Streaming" and
    // "video-streaming" are the same wiki to the server.
    expect(newWikiNameError('Video Streaming', ['video-streaming'])).toBe(
      'A wiki named "video-streaming" already exists.',
    );
  });

  it('accepts a fresh name', () => {
    expect(newWikiNameError('Image Archive', ['video-streaming'])).toBeNull();
  });
});

describe('wikiIdFromName [unit]', () => {
  it('caps ids at 60 characters like the server, without a trailing dash', () => {
    const id = wikiIdFromName(`${'a'.repeat(59)} b`);
    expect(id.length).toBeLessThanOrEqual(60);
    expect(id.endsWith('-')).toBe(false);
  });
});
