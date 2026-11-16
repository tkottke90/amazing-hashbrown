import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { OrientResult } from '@tkottke90/llm-wiki';
import { formatWikiOrientation } from './wiki-orientation-format.js';

describe('agents/wiki-orientation-format', () => {
  describe('formatWikiOrientation', () => {
    it('renders (empty) for an empty schema and index [unit]', () => {
      const result: OrientResult = { schema: '', index: '', recentLog: [] };
      const text = formatWikiOrientation('user', result);
      expect(text).to.include('## Schema\n(empty)');
      expect(text).to.include('## Index\n(empty)');
    });

    it('renders a placeholder when recentLog is empty [unit]', () => {
      const result: OrientResult = { schema: 'tags: []', index: 'index.md', recentLog: [] };
      const text = formatWikiOrientation('user', result);
      expect(text).to.include('## Recent Log\n(no log entries yet)');
    });

    it('formats each recentLog entry as a dated bullet line [unit]', () => {
      const result: OrientResult = {
        schema: '',
        index: '',
        recentLog: [
          { date: '2026-01-01', action: 'created', subject: 'entities/foo.md', raw: '# raw' },
        ],
      };
      const text = formatWikiOrientation('user', result);
      expect(text).to.include('- [2026-01-01] created | entities/foo.md');
    });

    it('truncates a long index at a line boundary with a count suffix [unit]', () => {
      // 300 lines of 20 chars each (6000 chars) comfortably exceeds the
      // 4000-char cap, forcing truncation partway through.
      const lines = Array.from({ length: 300 }, (_, i) => `entry-${i}`.padEnd(20, '-'));
      const index = lines.join('\n');
      const result: OrientResult = { schema: '', index, recentLog: [] };
      const text = formatWikiOrientation('user', result);

      expect(text).to.include('[index truncated —');
      expect(text).to.include('more entries omitted; use wiki_search for details]');
      // The tail of the full index must not appear — confirms truncation
      // actually happened rather than the suffix being appended to the whole thing.
      expect(text).to.not.include(lines[lines.length - 1]);
    });

    it('does not truncate an index under the cap [unit]', () => {
      const result: OrientResult = { schema: '', index: 'short index', recentLog: [] };
      const text = formatWikiOrientation('user', result);
      expect(text).to.include('## Index\nshort index');
      expect(text).to.not.include('truncated');
    });

    it('includes the wikiId in the heading [unit]', () => {
      const result: OrientResult = { schema: '', index: '', recentLog: [] };
      const text = formatWikiOrientation('self', result);
      expect(text).to.include('# Wiki Orientation: self');
    });
  });
});
