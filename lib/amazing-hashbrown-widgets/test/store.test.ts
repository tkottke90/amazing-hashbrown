import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/store.js';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'widgets-root-'));
}

describe('store', () => {
  describe('listWidgets', () => {
    it('returns an empty list when the dashboard folder does not exist', async () => {
      const root = await tmpRoot();
      expect(await store.listWidgets(root, 'default')).to.deep.equal([]);
    });

    it('returns created widgets sorted by order', async () => {
      const root = await tmpRoot();
      await store.createWidget(root, 'default', { title: 'First', content: 'a' });
      await store.createWidget(root, 'default', { title: 'Second', content: 'b' });
      const results = await store.listWidgets(root, 'default');
      expect(results).to.have.length(2);
      expect(results.every((r) => r.status === 'ok')).to.equal(true);
      const titles = results.map((r) => (r.status === 'ok' ? r.widget.title : null));
      expect(titles).to.deep.equal(['First', 'Second']);
    });

    it('surfaces a malformed file as an error entry, appended after ok entries, without throwing', async () => {
      const root = await tmpRoot();
      await store.createWidget(root, 'default', { title: 'Good', content: 'a' });
      const dir = path.join(root, 'default');
      await fs.writeFile(
        path.join(dir, 'broken.md'),
        '---\ntitle: [unterminated\n---\nBody',
        'utf8',
      );

      const results = await store.listWidgets(root, 'default');
      expect(results).to.have.length(2);
      expect(results[0]?.status).to.equal('ok');
      expect(results[1]).to.deep.include({ status: 'error', id: 'broken' });
      expect((results[1] as { error: string }).error).to.be.a('string');
    });
  });

  describe('createWidget', () => {
    it('slugifies the title into the filename', async () => {
      const root = await tmpRoot();
      const widget = await store.createWidget(root, 'default', {
        title: 'Getting Started!',
        content: 'x',
      });
      expect(widget.id).to.equal('getting-started');
      await fs.access(path.join(root, 'default', 'getting-started.md'));
    });

    it('resolves a filename collision with a UUID-suffixed slug', async () => {
      const root = await tmpRoot();
      const first = await store.createWidget(root, 'default', { title: 'Tip', content: 'a' });
      const second = await store.createWidget(root, 'default', { title: 'Tip', content: 'b' });
      expect(first.id).to.equal('tip');
      expect(second.id).to.match(/^tip-[0-9a-f]{8}$/);
      expect(second.id).to.not.equal(first.id);
    });

    it('assigns sequential order to successive widgets', async () => {
      const root = await tmpRoot();
      const a = await store.createWidget(root, 'default', { title: 'A', content: 'x' });
      const b = await store.createWidget(root, 'default', { title: 'B', content: 'y' });
      expect(a.order).to.equal(0);
      expect(b.order).to.equal(1);
    });
  });

  describe('updateWidget', () => {
    it('updates content without renaming the file or changing order', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        title: 'Original',
        content: 'x',
      });
      const updated = await store.updateWidget(root, 'default', created.id, {
        title: 'Changed Title',
        content: 'new content',
      });
      expect(updated.id).to.equal(created.id);
      expect(updated.order).to.equal(created.order);
      expect(updated.title).to.equal('Changed Title');

      const [result] = await store.listWidgets(root, 'default');
      expect(result?.status).to.equal('ok');
    });

    it('throws WidgetNotFoundError for a missing id', async () => {
      const root = await tmpRoot();
      try {
        await store.updateWidget(root, 'default', 'does-not-exist', { title: 'x', content: 'y' });
        expect.fail('expected updateWidget to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(store.WidgetNotFoundError);
      }
    });
  });

  describe('updateWidgetRaw', () => {
    it('writes the raw content verbatim with no validation', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', { title: 'Tip', content: 'x' });
      await store.updateWidgetRaw(root, 'default', created.id, '---\nstill: broken\n---\nBody');

      const [result] = await store.listWidgets(root, 'default');
      expect(result?.status).to.equal('error');
    });

    it('throws WidgetNotFoundError for a missing id', async () => {
      const root = await tmpRoot();
      try {
        await store.updateWidgetRaw(root, 'default', 'does-not-exist', 'anything');
        expect.fail('expected updateWidgetRaw to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(store.WidgetNotFoundError);
      }
    });
  });

  describe('deleteWidget', () => {
    it('removes the file', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', { title: 'Tip', content: 'x' });
      await store.deleteWidget(root, 'default', created.id);
      expect(await store.listWidgets(root, 'default')).to.deep.equal([]);
    });

    it('throws WidgetNotFoundError for a missing id', async () => {
      const root = await tmpRoot();
      try {
        await store.deleteWidget(root, 'default', 'does-not-exist');
        expect.fail('expected deleteWidget to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(store.WidgetNotFoundError);
      }
    });
  });

  describe('ensureSeeded', () => {
    it('seeds 4 sample widgets when the dashboard folder is missing', async () => {
      const root = await tmpRoot();
      await store.ensureSeeded(root, 'default');
      const results = await store.listWidgets(root, 'default');
      expect(results).to.have.length(4);
      expect(results.every((r) => r.status === 'ok')).to.equal(true);
    });

    it('is a no-op when the dashboard folder already has widgets', async () => {
      const root = await tmpRoot();
      await store.createWidget(root, 'default', { title: 'Mine', content: 'x' });
      await store.ensureSeeded(root, 'default');
      const results = await store.listWidgets(root, 'default');
      expect(results).to.have.length(1);
    });
  });

  describe('path-traversal guard', () => {
    it('rejects a dashboardId containing a path separator', async () => {
      const root = await tmpRoot();
      try {
        await store.listWidgets(root, '../escape');
        expect.fail('expected listWidgets to throw');
      } catch (err) {
        expect((err as Error).message).to.match(/invalid/i);
      }
    });

    it('rejects a widget id containing a path separator', async () => {
      const root = await tmpRoot();
      try {
        await store.deleteWidget(root, 'default', '../../escape');
        expect.fail('expected deleteWidget to throw');
      } catch (err) {
        expect((err as Error).message).to.match(/invalid/i);
      }
    });
  });
});
