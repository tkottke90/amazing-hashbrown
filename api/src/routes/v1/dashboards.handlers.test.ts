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
      const result = await createWidgetHandler(root, 'default', { content: 'x' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });
  });

  describe('updateWidgetHandler()', () => {
    it('updates an existing widget [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', { title: 'Tip', content: 'a' });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        title: 'New Title',
        content: 'b',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.title).to.equal('New Title');
    });

    it('returns 404 for a widget id that does not exist [unit]', async () => {
      const result = await updateWidgetHandler(root, 'default', 'nope', {
        title: 'x',
        content: 'y',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 when content is missing from the body [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', { title: 'Tip', content: 'a' });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        title: 'x',
      } as unknown as { title: string; content: string });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });
  });

  describe('updateWidgetRawHandler()', () => {
    it('writes raw content with no validation, even if it is still broken [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', { title: 'Tip', content: 'a' });
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
      const created = await createWidgetHandler(root, 'default', { title: 'Tip', content: 'a' });
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
      const created = await createWidgetHandler(root, 'default', { title: 'Tip', content: 'a' });
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
