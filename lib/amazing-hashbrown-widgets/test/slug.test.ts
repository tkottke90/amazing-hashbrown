import { expect } from 'chai';
import { slugify, withCollisionSuffix } from '../src/internal/slug.js';

describe('slug', () => {
  it('slugify lowercases, hyphenates, and strips punctuation', () => {
    expect(slugify('Getting Started!')).to.equal('getting-started');
  });

  it('slugify strips leading/trailing hyphens produced by stripped punctuation', () => {
    expect(slugify('--Hello--')).to.equal('hello');
  });

  it('withCollisionSuffix appends 8 hex characters distinct per call', () => {
    const a = withCollisionSuffix('tip');
    const b = withCollisionSuffix('tip');
    expect(a).to.match(/^tip-[0-9a-f]{8}$/);
    expect(b).to.match(/^tip-[0-9a-f]{8}$/);
    expect(a).to.not.equal(b);
  });
});
