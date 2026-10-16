import { expect } from 'chai';
import * as frontmatter from '../src/internal/frontmatter.js';

describe('frontmatter', () => {
  it('round-trips parse/serialize', () => {
    const raw = frontmatter.serialize(
      { title: 'Welcome', type: 'markdown', order: 0 },
      '# Hello\n\nBody text.',
    );
    const { data, body } = frontmatter.parse(raw);
    expect(data).to.deep.equal({ title: 'Welcome', type: 'markdown', order: 0 });
    expect(body.trim()).to.equal('# Hello\n\nBody text.');
  });

  it('toMarkdownWidget builds a widget from valid frontmatter + body', () => {
    const raw = frontmatter.serialize(
      { title: 'Tip', subtitle: 'Of the day', type: 'markdown', order: 2 },
      'Some content.',
    );
    const widget = frontmatter.toMarkdownWidget('tip', raw);
    expect(widget.content.trim()).to.equal('Some content.');
    expect({ ...widget, content: widget.content.trim() }).to.deep.equal({
      id: 'tip',
      type: 'markdown',
      title: 'Tip',
      subtitle: 'Of the day',
      order: 2,
      content: 'Some content.',
    });
  });

  it('toMarkdownWidget throws when a required field is missing', () => {
    const raw = frontmatter.serialize({ type: 'markdown', order: 0 }, 'Body');
    expect(() => frontmatter.toMarkdownWidget('broken', raw)).to.throw(/title/i);
  });

  it('toMarkdownWidget throws on malformed YAML frontmatter', () => {
    const raw = '---\ntitle: [unterminated\n---\nBody';
    expect(() => frontmatter.toMarkdownWidget('broken', raw)).to.throw();
  });
});
