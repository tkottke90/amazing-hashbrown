import { describe, it } from 'mocha';
import { expect } from 'chai';
import { validateWidgetHandler } from './widgets.handlers.js';

describe('routes/v1/widgets.handlers', () => {
  describe('validateWidgetHandler()', () => {
    it('returns an inner ok:true with the parsed widget fields for a well-formed file [unit]', () => {
      const raw = '---\ntitle: "Tip"\ntype: "markdown"\norder: 2\n---\n\nBody text.';
      const result = validateWidgetHandler({ dashboardId: 'default', widgetId: 'tip', raw });
      expect(result.ok).to.equal(true);
      if (result.ok && result.data.ok) {
        expect(result.data.widget.title).to.equal('Tip');
        expect(result.data.widget.content.trim()).to.equal('Body text.');
      } else {
        throw new Error('expected a successful validation');
      }
    });

    it('returns an inner ok:false (still HTTP 200) for malformed YAML frontmatter [unit]', () => {
      const result = validateWidgetHandler({
        dashboardId: 'default',
        widgetId: 'broken',
        raw: '---\ntitle: [unterminated\n---\nBody',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.ok).to.equal(false);
    });

    it('returns an inner ok:false for valid YAML that fails the schema (missing title) [unit]', () => {
      const result = validateWidgetHandler({
        dashboardId: 'default',
        widgetId: 'x',
        raw: '---\ntype: "markdown"\norder: 0\n---\nBody',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.ok).to.equal(false);
    });

    it('rejects a request missing dashboardId/widgetId/raw with 400 [unit]', () => {
      const result = validateWidgetHandler({ raw: 'x' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('performs no lookup — a nonexistent dashboardId/widgetId still validates [unit]', () => {
      const raw = '---\ntitle: "X"\ntype: "markdown"\norder: 0\n---\nBody';
      const result = validateWidgetHandler({
        dashboardId: 'does-not-exist',
        widgetId: 'also-does-not-exist',
        raw,
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.ok).to.equal(true);
    });

    it('validates a well-formed big-number widget file [unit]', () => {
      const raw = '---\ntitle: "Count"\ntype: "big-number"\norder: 0\nvalue: 5\n---\n';
      const result = validateWidgetHandler({ dashboardId: 'default', widgetId: 'count', raw });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.ok).to.equal(true);
    });

    it('validates a well-formed line-graph widget file [unit]', () => {
      const raw =
        '---\ntitle: "Response time"\ntype: "line-graph"\norder: 0\n---\nlabel,value\n09:00,120';
      const result = validateWidgetHandler({ dashboardId: 'default', widgetId: 'rt', raw });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.ok).to.equal(true);
    });

    it('rejects a line-graph widget file whose CSV body is missing its header [unit]', () => {
      const raw = '---\ntitle: "Response time"\ntype: "line-graph"\norder: 0\n---\n09:00,120';
      const result = validateWidgetHandler({ dashboardId: 'default', widgetId: 'rt', raw });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.ok).to.equal(false);
    });

    it('validates a well-formed pie-graph widget file [unit]', () => {
      const raw =
        '---\ntitle: "Agent usage"\ntype: "pie-graph"\norder: 0\n---\nlabel,value\nQuery,30\nAnalysis,25';
      const result = validateWidgetHandler({ dashboardId: 'default', widgetId: 'au', raw });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.ok).to.equal(true);
    });

    it('rejects a pie-graph widget file with a negative value [unit]', () => {
      const raw =
        '---\ntitle: "Agent usage"\ntype: "pie-graph"\norder: 0\n---\nlabel,value\nQuery,30\nAnalysis,-5';
      const result = validateWidgetHandler({ dashboardId: 'default', widgetId: 'au', raw });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.ok).to.equal(false);
    });

    it('rejects a line-graph widget file with an invalid hex color override [unit]', () => {
      const raw =
        '---\ntitle: "Response time"\ntype: "line-graph"\norder: 0\ncolor: "not-a-color"\n---\nlabel,value\n09:00,120';
      const result = validateWidgetHandler({ dashboardId: 'default', widgetId: 'rt', raw });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.ok).to.equal(false);
    });
  });
});
