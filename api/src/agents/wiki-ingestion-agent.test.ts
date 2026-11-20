import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildWikiIngestionTools, buildWikiIngestionMiddleware } from './wiki-ingestion-agent.js';
import { modelInputSnapshotMiddleware } from './model-input-snapshot.middleware.js';

enum TestTypes {
  UNIT = '[unit]',
}

describe('agents/wiki-ingestion-agent', () => {
  describe('buildWikiIngestionTools()', () => {
    it(`includes wiki_rebaseline_source ${TestTypes.UNIT}`, () => {
      const names = buildWikiIngestionTools().map((t) => t.name);
      expect(names).to.include('wiki_rebaseline_source');
    });

    it(`still includes wiki_create_page, wiki_update_page, wiki_add_cross_link ${TestTypes.UNIT}`, () => {
      // Regression guard for the ...buildWikiWriteTools() substitution —
      // these three were hand-listed before and must not silently drop out.
      const names = buildWikiIngestionTools().map((t) => t.name);
      expect(names).to.include.members([
        'wiki_create_page',
        'wiki_update_page',
        'wiki_add_cross_link',
      ]);
    });
  });

  describe('buildWikiIngestionMiddleware()', () => {
    it(`includes modelInputSnapshotMiddleware ${TestTypes.UNIT}`, () => {
      expect(buildWikiIngestionMiddleware()).to.include(modelInputSnapshotMiddleware);
    });

    it(`places modelInputSnapshotMiddleware last ${TestTypes.UNIT}`, () => {
      // wrapModelCall hooks nest in array order — last must stay innermost
      // so it sees the request after every upstream middleware has run.
      const middleware = buildWikiIngestionMiddleware();
      expect(middleware[middleware.length - 1]).to.equal(modelInputSnapshotMiddleware);
    });
  });
});
