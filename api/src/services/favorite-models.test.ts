import { describe, it } from 'mocha';
import { expect } from 'chai';
import { resolveAvailableFavorites } from './favorite-models.js';

describe('services/favorite-models', () => {
  describe('resolveAvailableFavorites()', () => {
    const providers = [
      { name: 'do', models: [{ id: 'llama' }, { id: 'mistral' }] },
      { name: 'local', models: [{ id: 'qwen3:14b' }] },
    ];

    it('keeps favorites whose provider and model are both live, in the user-chosen order [unit]', () => {
      const favorites = [
        { provider: 'local', model: 'qwen3:14b' },
        { provider: 'do', model: 'mistral' },
      ];
      expect(resolveAvailableFavorites(favorites, providers)).to.deep.equal(favorites);
    });

    it('drops a favorite whose provider was renamed or removed so chat never offers a dead choice [unit]', () => {
      expect(
        resolveAvailableFavorites([{ provider: 'gone', model: 'llama' }], providers),
      ).to.deep.equal([]);
    });

    it('drops a favorite whose model is no longer in the live list (e.g. a retired router model) [unit]', () => {
      expect(
        resolveAvailableFavorites(
          [
            { provider: 'do', model: 'retired' },
            { provider: 'do', model: 'llama' },
          ],
          providers,
        ),
      ).to.deep.equal([{ provider: 'do', model: 'llama' }]);
    });

    it('drops favorites of an unreachable provider, which reports no models [unit]', () => {
      expect(
        resolveAvailableFavorites(
          [{ provider: 'down', model: 'x' }],
          [{ name: 'down', models: [] }],
        ),
      ).to.deep.equal([]);
    });

    it('does not confuse the same model id across providers [unit]', () => {
      expect(
        resolveAvailableFavorites([{ provider: 'local', model: 'llama' }], providers),
      ).to.deep.equal([]);
    });

    it('returns an empty list when there are no favorites [unit]', () => {
      expect(resolveAvailableFavorites([], providers)).to.deep.equal([]);
    });
  });
});
