import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
  listWidgetsHandler,
  createWidgetHandler,
  updateWidgetHandler,
  updateWidgetRawHandler,
  deleteWidgetHandler,
} from './dashboards.handlers.js';

describe('routes/v1/dashboards.handlers', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dashboards-handlers-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('listWidgetsHandler()', () => {
    it('returns an empty list when the dashboard has no widgets yet [unit]', async () => {
      const result = await listWidgetsHandler(root, 'default');
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal([]);
    });
  });

  describe('createWidgetHandler()', () => {
    it('creates a markdown widget and returns it [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Welcome',
        subtitle: 'Hi',
        content: '# Hello',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.title).to.equal('Welcome');
        expect(result.data.type).to.equal('markdown');
      }
    });

    it('rejects a body missing a title with 400 [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', { type: 'markdown', content: 'x' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('rejects a body with no type at all with 400 [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', { title: 'x', content: 'x' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('creates a big-number widget [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Messages',
        value: 12547,
        unit: 'messages',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.type).to.equal('big-number');
        expect(result.data).to.deep.include({ value: 12547, unit: 'messages' });
      }
    });

    it('creates a big-number widget with no value [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Open questions',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect((result.data as { value?: number }).value).to.equal(undefined);
    });

    it('creates a line-graph widget [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'line-graph',
        title: 'Response time',
        data: 'label,value\n09:00,120\n09:05,135',
        color: '#ff0000',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.type).to.equal('line-graph');
    });

    it('rejects a line-graph widget with an invalid hex color with 400 [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'line-graph',
        title: 'Response time',
        data: 'label,value\n09:00,120',
        color: 'not-a-color',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('rejects a line-graph widget whose CSV is missing its header with 400 [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'line-graph',
        title: 'Response time',
        data: '09:00,120\n09:05,135',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('creates a pie-graph widget [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'pie-graph',
        title: 'Agent usage',
        data: 'label,value\nQuery,30\nAnalysis,25',
        colors: ['#111111', '#222222'],
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.type).to.equal('pie-graph');
    });

    it('rejects a pie-graph widget with a negative value with 400 [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'pie-graph',
        title: 'Agent usage',
        data: 'label,value\nQuery,30\nAnalysis,-5',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('ignores a field that belongs to a different type than the one declared [unit]', async () => {
      // Zod's default (non-strict) object parsing drops unknown keys rather
      // than rejecting them — `data` isn't a big-number field, so it's
      // silently dropped, consistent with every other schema in this file
      // not using `.strict()`.
      const result = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Count',
        data: 'label,value\nA,1',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.type).to.equal('big-number');
        expect((result.data as { data?: string }).data).to.equal(undefined);
      }
    });
  });

  describe('updateWidgetHandler()', () => {
    it('updates an existing widget [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'markdown',
        title: 'New Title',
        content: 'b',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.title).to.equal('New Title');
    });

    it('returns 404 for a widget id that does not exist [unit]', async () => {
      const result = await updateWidgetHandler(root, 'default', 'nope', {
        type: 'markdown',
        title: 'x',
        content: 'y',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 when content is missing from the body [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'markdown',
        title: 'x',
      } as unknown as { type: 'markdown'; title: string; content: string });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('updates a big-number widget [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Count',
        value: 1,
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'big-number',
        title: 'Count',
        value: 2,
        unit: 'things',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.include({ value: 2, unit: 'things' });
    });
  });

  describe('updateWidgetRawHandler()', () => {
    it('writes raw content with no validation, even if it is still broken [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetRawHandler(root, 'default', created.data.id, {
        raw: '---\nstill: broken\n---\nBody',
      });
      expect(result.ok).to.equal(true);

      const list = await listWidgetsHandler(root, 'default');
      if (list.ok) expect(list.data[0]?.status).to.equal('error');
    });

    it('returns 404 for a widget id that does not exist [unit]', async () => {
      const result = await updateWidgetRawHandler(root, 'default', 'nope', { raw: 'anything' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 when raw is not a string [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetRawHandler(
        root,
        'default',
        created.data.id,
        {} as unknown as { raw: string },
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });
  });

  describe('deleteWidgetHandler()', () => {
    it('deletes an existing widget [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await deleteWidgetHandler(root, 'default', created.data.id);
      expect(result.ok).to.equal(true);

      const list = await listWidgetsHandler(root, 'default');
      if (list.ok) expect(list.data).to.have.length(0);
    });

    it('returns 404 for a widget id that does not exist [unit]', async () => {
      const result = await deleteWidgetHandler(root, 'default', 'nope');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });
  });
});
