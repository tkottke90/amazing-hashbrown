import { expect } from 'chai';
import { parse, serialize, missingRequired, parseTaxonomy } from '../src/internal/frontmatter.js';

describe('frontmatter/parse + serialize', () => {
  it('round-trips frontmatter and body', () => {
    const doc = serialize({ title: 'Foo', tags: ['a', 'b'] }, 'Body text here.');
    const { data, body } = parse(doc);
    expect(data.title).to.equal('Foo');
    expect(data.tags).to.deep.equal(['a', 'b']);
    expect(body.trim()).to.equal('Body text here.');
  });

  it('parses documents without frontmatter as pure body', () => {
    const { data, body } = parse('no frontmatter here');
    expect(data).to.deep.equal({});
    expect(body).to.equal('no frontmatter here');
  });
});

describe('frontmatter/missingRequired', () => {
  it('flags absent required fields', () => {
    const missing = missingRequired({ title: 'X' });
    expect(missing).to.include.members(['created', 'updated', 'type', 'tags', 'sources']);
  });

  it('flags tags/sources that are not arrays', () => {
    const missing = missingRequired({
      title: 'X',
      created: '2026-01-01',
      updated: '2026-01-01',
      type: 'entity',
      tags: 'not-an-array',
      sources: [],
    });
    expect(missing).to.include('tags');
    expect(missing).to.not.include('sources');
  });

  it('passes a complete frontmatter block', () => {
    expect(
      missingRequired({
        title: 'X',
        created: '2026-01-01',
        updated: '2026-01-01',
        type: 'entity',
        tags: ['a'],
        sources: ['raw/x.md'],
      }),
    ).to.have.length(0);
  });
});

describe('frontmatter/parseTaxonomy', () => {
  it('extracts grouped and ungrouped tags, lowercased', () => {
    const schema = [
      '# Wiki Schema',
      '## Tag Taxonomy',
      '- Hosts: host, VM, container',
      '- proxy',
      '## Page Thresholds',
      '- not a tag',
    ].join('\n');
    const tags = parseTaxonomy(schema);
    expect(tags.has('host')).to.equal(true);
    expect(tags.has('vm')).to.equal(true);
    expect(tags.has('container')).to.equal(true);
    expect(tags.has('proxy')).to.equal(true);
    expect(tags.has('not a tag')).to.equal(false);
  });

  it('ignores the skeleton placeholder bullet', () => {
    const schema = '## Tag Taxonomy\n- (define 10-20 tags for this domain)\n';
    expect(parseTaxonomy(schema).size).to.equal(0);
  });
});
