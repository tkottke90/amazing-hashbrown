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

    it('parses a big-number widget with no body', () => {
      const raw = frontmatter.serialize(
        { title: 'Count', type: 'big-number', order: 0, value: 5, unit: 'things' },
        '',
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.widget).to.deep.equal({
          title: 'Count',
          type: 'big-number',
          order: 0,
          value: 5,
          unit: 'things',
        });
      }
    });

    it('parses a big-number widget with no value as absent', () => {
      const raw = frontmatter.serialize(
        { title: 'Open questions', type: 'big-number', order: 0 },
        '',
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.widget).to.not.have.property('value');
    });

    it('rejects a big-number widget missing order', () => {
      const raw = frontmatter.serialize({ title: 'Count', type: 'big-number' }, '');
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(false);
    });

    it('parses a line-graph widget, storing its CSV Body verbatim as data', () => {
      const csv = 'label,value\n09:00,120\n09:05,135';
      const raw = frontmatter.serialize(
        { title: 'Response time', type: 'line-graph', order: 0, color: '#ff0000' },
        csv,
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.widget).to.deep.include({ type: 'line-graph', color: '#ff0000' });
        expect((result.widget as { data: string }).data.trim()).to.equal(csv);
      }
    });

    it('rejects a line-graph widget with an invalid hex color override', () => {
      const raw = frontmatter.serialize(
        { title: 'Response time', type: 'line-graph', order: 0, color: 'not-a-color' },
        'label,value\n09:00,1',
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(false);
    });

    it('rejects a line-graph widget whose CSV Body is missing its header', () => {
      const raw = frontmatter.serialize(
        { title: 'Response time', type: 'line-graph', order: 0 },
        '09:00,120\n09:05,135',
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.error).to.match(/header/i);
    });

    it('parses a pie-graph widget, storing its CSV Body verbatim as data', () => {
      const csv = 'label,value\nQuery,30\nAnalysis,25';
      const raw = frontmatter.serialize(
        { title: 'Agent usage', type: 'pie-graph', order: 0, colors: ['#111111', '#222222'] },
        csv,
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.widget).to.deep.include({
          type: 'pie-graph',
          colors: ['#111111', '#222222'],
        });
        expect((result.widget as { data: string }).data.trim()).to.equal(csv);
      }
    });

    it('rejects a pie-graph widget with any negative value', () => {
      const raw = frontmatter.serialize(
        { title: 'Agent usage', type: 'pie-graph', order: 0 },
        'label,value\nQuery,30\nAnalysis,-5',
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.error).to.match(/non-negative/i);
    });

    it('allows a negative value for a line-graph widget', () => {
      const raw = frontmatter.serialize(
        { title: 'Temperature delta', type: 'line-graph', order: 0 },
        'label,value\nMon,-2\nTue,3',
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(true);
    });

    it('rejects a pie-graph widget with an invalid hex colors entry', () => {
      const raw = frontmatter.serialize(
        { title: 'Agent usage', type: 'pie-graph', order: 0, colors: ['#111111', 'nope'] },
        'label,value\nQuery,30',
      );
      const result = frontmatter.parseWidgetFile(raw);
      expect(result.ok).to.equal(false);
    });
  });

  describe('parseCsvBody', () => {
    it('parses a valid two-column CSV body into labels/values', () => {
      const result = frontmatter.parseCsvBody('label,value\nA,1\nB,2');
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.equal({ labels: ['A', 'B'], values: [1, 2] });
      }
    });

    it('rejects a body missing the required header', () => {
      const result = frontmatter.parseCsvBody('A,1\nB,2');
      expect(result.ok).to.equal(false);
    });

    it('rejects an empty body', () => {
      const result = frontmatter.parseCsvBody('');
      expect(result.ok).to.equal(false);
    });

    it('rejects a header with no data rows', () => {
      const result = frontmatter.parseCsvBody('label,value');
      expect(result.ok).to.equal(false);
    });

    it('rejects a row whose label contains a comma', () => {
      const result = frontmatter.parseCsvBody('label,value\n"Jan 1, 2026",120');
      expect(result.ok).to.equal(false);
    });

    it('rejects a non-numeric value', () => {
      const result = frontmatter.parseCsvBody('label,value\nA,not-a-number');
      expect(result.ok).to.equal(false);
    });
  });
});
