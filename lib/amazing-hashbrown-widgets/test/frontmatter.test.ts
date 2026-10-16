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

  describe('parseWidgetFile', () => {
    it('returns ok:true with widget fields (no id) for a valid file', () => {
      const raw = frontmatter.serialize(
        { title: 'Tip', type: 'markdown', order: 2 },
        'Some content.',
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.widget).to.not.have.property('id');
        expect({ ...result.widget, content: result.widget.content.trim() }).to.deep.equal({
          title: 'Tip',
          type: 'markdown',
          order: 2,
          content: 'Some content.',
        });
      }
    });

    it('returns ok:false on malformed YAML frontmatter', () => {
      const result = frontmatter.parseWidgetFile('---\ntitle: [unterminated\n---\nBody');
      expect(result.ok).to.equal(false);
    });

    it('returns ok:false when YAML is valid but fails the schema (missing title)', () => {
      const raw = frontmatter.serialize({ type: 'markdown', order: 0 }, 'Body');
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.error).to.match(/title/i);
    });
  });
});
