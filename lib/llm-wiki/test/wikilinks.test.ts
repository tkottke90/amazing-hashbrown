import { expect } from 'chai';
import { normalizeLink, parseExternalRef } from '../src/internal/wikilinks.js';

describe('parseExternalRef', () => {
  it('returns null for a bare page path with no colon', () => {
    expect(parseExternalRef('entities/foo')).to.equal(null);
  });

  it('splits a wikiId:pagePath reference on the first colon', () => {
    expect(parseExternalRef('other-wiki:entities/foo')).to.deep.equal({
      wikiId: 'other-wiki',
      pagePath: 'entities/foo',
    });
  });

  it('treats a leading colon (empty wiki id) as not external', () => {
    expect(parseExternalRef(':entities/foo')).to.equal(null);
  });

  it('treats a trailing colon (empty page path) as not external', () => {
    expect(parseExternalRef('other-wiki:')).to.equal(null);
  });

  it('composes with normalizeLink so alias and .md stripping happen first', () => {
    const normalized = normalizeLink('other-wiki:entities/foo.md|Some Label');
    expect(normalized).to.equal('other-wiki:entities/foo');
    expect(parseExternalRef(normalized)).to.deep.equal({
      wikiId: 'other-wiki',
      pagePath: 'entities/foo',
    });
  });

  it('splits only on the first colon, keeping any later colons in pagePath', () => {
    expect(parseExternalRef('other-wiki:entities/foo:bar')).to.deep.equal({
      wikiId: 'other-wiki',
      pagePath: 'entities/foo:bar',
    });
  });
});
