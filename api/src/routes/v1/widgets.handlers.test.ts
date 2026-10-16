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
  });
});
