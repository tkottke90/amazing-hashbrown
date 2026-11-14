import { describe, it } from 'mocha';
import { expect } from 'chai';
import { parseAppDoc, parseGlossary, MAX_PAGE_CHARS } from './harness-docs-parser.js';

enum TestTypes {
  UNIT = '[unit]',
}

describe('scripts/harness-docs-parser', () => {
  describe('parseGlossary', () => {
    it(`parses a single-term entry into its own page, tagged with its enclosing section ${TestTypes.UNIT}`, () => {
      const markdown = [
        '# Dashboard Widgets',
        '',
        '## Language',
        '',
        '**Widget**:',
        'One self-contained unit of dashboard content, persisted as its own file.',
        '_Avoid_: Card, tile, block',
        '',
      ].join('\n');

      const pages = parseGlossary(markdown);

      expect(pages).to.have.lengthOf(1);
      expect(pages[0].title).to.equal('Widget');
      expect(pages[0].tags).to.deep.equal(['Dashboard Widgets']);
      expect(pages[0].sources).to.deep.equal(['GLOSSARY.md#widget']);
      expect(pages[0].body).to.include('One self-contained unit');
      expect(pages[0].body).to.include('_Avoid_: Card, tile, block');
    });

    it(`parses a combined "**A** / **B**:" entry as one page with both names in the title ${TestTypes.UNIT}`, () => {
      const markdown = [
        '# Thread Archiving & Sidebar Visibility',
        '',
        '## Language',
        '',
        '**Archive** / **Unarchive**:',
        "The two actions that set and clear a thread's archive timestamp.",
        '_Avoid_: Close/Reopen, Lock/Unlock',
        '',
      ].join('\n');

      const pages = parseGlossary(markdown);

      expect(pages).to.have.lengthOf(1);
      expect(pages[0].title).to.equal('Archive / Unarchive');
    });

    it(`starts a new page at the next term line without swallowing the following entry ${TestTypes.UNIT}`, () => {
      const markdown = [
        '# Section',
        '',
        '## Language',
        '',
        '**First Term**:',
        'Definition of first term.',
        '_Avoid_: nothing',
        '',
        '**Second Term**:',
        'Definition of second term.',
        '_Avoid_: nothing else',
      ].join('\n');

      const pages = parseGlossary(markdown);

      expect(pages).to.have.lengthOf(2);
      expect(pages[0].title).to.equal('First Term');
      expect(pages[0].body).to.not.include('Second Term');
      expect(pages[1].title).to.equal('Second Term');
    });

    it(`tags a term with the most recent top-level section, not a nested sub-heading ${TestTypes.UNIT}`, () => {
      const markdown = [
        '# Dashboard Widgets',
        '',
        '## Language',
        '',
        '### System Widgets',
        '',
        '**System Widget**:',
        "A widget with source: 'system'.",
        '_Avoid_: nothing',
      ].join('\n');

      const pages = parseGlossary(markdown);

      expect(pages).to.have.lengthOf(1);
      expect(pages[0].tags).to.deep.equal(['Dashboard Widgets']);
    });
  });

  describe('parseAppDoc', () => {
    it(`splits a file into one page per heading, tagged with the filename ${TestTypes.UNIT}`, () => {
      const markdown = [
        '# Configuration',
        '',
        '## `embeddings`',
        '',
        'Powers semantic search.',
        '',
      ].join('\n');

      const pages = parseAppDoc('configuration.md', markdown);

      expect(pages).to.have.lengthOf(2);
      expect(pages[0].title).to.equal('Configuration');
      expect(pages[1].title).to.equal('embeddings');
      expect(pages[1].tags).to.deep.equal(['configuration']);
      expect(pages[1].sources).to.deep.equal(['configuration.md#embeddings']);
      expect(pages[1].body).to.include('Powers semantic search.');
    });

    it(`does not treat a "#"-prefixed bash comment inside a fenced code block as a heading ${TestTypes.UNIT}`, () => {
      const markdown = [
        '# Evaluations',
        '',
        '## CLI Reference',
        '',
        '```bash',
        '# Run every suite under suites/',
        'npm run eval',
        '```',
        '',
        'Some trailing prose.',
      ].join('\n');

      const pages = parseAppDoc('Evaluations.md', markdown);

      expect(pages).to.have.lengthOf(2);
      expect(pages[1].title).to.equal('CLI Reference');
      expect(pages[1].body).to.include('# Run every suite under suites/');
      expect(pages[1].body).to.include('Some trailing prose.');
    });

    it(`strips a single pair of surrounding backticks from a heading title ${TestTypes.UNIT}`, () => {
      const markdown = ['# Configuration', '', '## `database`', '', 'Database options.'].join('\n');

      const pages = parseAppDoc('configuration.md', markdown);

      expect(pages[1].title).to.equal('database');
    });

    it(`splits a section whose body exceeds MAX_PAGE_CHARS into multiple labeled parts ${TestTypes.UNIT}`, () => {
      const header = '| Suite | Purpose |';
      const separator = '|---|---|';
      const rows = Array.from(
        { length: 80 },
        (_, i) =>
          `| suite-${i} | A reasonably long purpose description for suite number ${i} that takes up real space. |`,
      );
      const markdown = [
        '# Evaluations',
        '',
        '## Available Suites',
        '',
        header,
        separator,
        ...rows,
      ].join('\n');

      const pages = parseAppDoc('Evaluations.md', markdown);

      const suitePages = pages.filter((p) => p.title.startsWith('Available Suites'));
      expect(suitePages.length).to.be.greaterThan(1);
      expect(suitePages[0].title).to.equal('Available Suites (part 1)');
      expect(suitePages[1].title).to.equal('Available Suites (part 2)');
      for (const page of suitePages) {
        expect(page.body.length).to.be.at.most(
          MAX_PAGE_CHARS + header.length + separator.length + 2,
        );
      }
      // Every row survives the split somewhere.
      const combined = suitePages.map((p) => p.body).join('\n');
      expect(combined).to.include('suite-0');
      expect(combined).to.include('suite-79');
    });

    it(`leaves a section at or under MAX_PAGE_CHARS as a single page ${TestTypes.UNIT}`, () => {
      const markdown = [
        '# Configuration',
        '',
        '## `chat`',
        '',
        'A short section well under budget.',
      ].join('\n');

      const pages = parseAppDoc('configuration.md', markdown);

      expect(pages.filter((p) => p.title.includes('part'))).to.have.lengthOf(0);
    });
  });
});
