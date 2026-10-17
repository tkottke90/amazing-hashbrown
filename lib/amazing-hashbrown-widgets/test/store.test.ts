import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as frontmatter from '../src/internal/frontmatter.js';
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
      await store.createWidget(root, 'default', { type: 'markdown', title: 'First', content: 'a' });
      await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Second',
        content: 'b',
      });
      const results = await store.listWidgets(root, 'default');
      expect(results).to.have.length(2);
      expect(results.every((r) => r.status === 'ok')).to.equal(true);
      const titles = results.map((r) => (r.status === 'ok' ? r.widget.title : null));
      expect(titles).to.deep.equal(['First', 'Second']);
    });

    it('surfaces a malformed file as an error entry, appended after ok entries, without throwing', async () => {
      const root = await tmpRoot();
      await store.createWidget(root, 'default', { type: 'markdown', title: 'Good', content: 'a' });
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

    it('round-trips one widget of each of the 4 types, sorted by order', async () => {
      const root = await tmpRoot();
      await store.createWidget(root, 'default', {
        type: 'pie-graph',
        title: 'Pie',
        data: 'label,value\nA,1\nB,2',
      });
      await store.createWidget(root, 'default', { type: 'markdown', title: 'Md', content: 'hi' });
      await store.createWidget(root, 'default', { type: 'big-number', title: 'Num', value: 5 });
      await store.createWidget(root, 'default', {
        type: 'line-graph',
        title: 'Line',
        data: 'label,value\n09:00,1',
      });

      const results = await store.listWidgets(root, 'default');
      expect(results).to.have.length(4);
      expect(results.every((r) => r.status === 'ok')).to.equal(true);
      const orders = results.map((r) => (r.status === 'ok' ? r.widget.order : null));
      expect(orders).to.deep.equal([0, 1, 2, 3]);
      const types = results.map((r) => (r.status === 'ok' ? r.widget.type : null));
      expect(types).to.deep.equal(['pie-graph', 'markdown', 'big-number', 'line-graph']);
    });
  });

  describe('createWidget', () => {
    it('slugifies the title into the filename', async () => {
      const root = await tmpRoot();
      const widget = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Getting Started!',
        content: 'x',
      });
      expect(widget.id).to.equal('getting-started');
      await fs.access(path.join(root, 'default', 'getting-started.md'));
    });

    it('resolves a filename collision with a UUID-suffixed slug', async () => {
      const root = await tmpRoot();
      const first = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'a',
      });
      const second = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'b',
      });
      expect(first.id).to.equal('tip');
      expect(second.id).to.match(/^tip-[0-9a-f]{8}$/);
      expect(second.id).to.not.equal(first.id);
    });

    it('assigns sequential order to successive widgets', async () => {
      const root = await tmpRoot();
      const a = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'A',
        content: 'x',
      });
      const b = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'B',
        content: 'y',
      });
      expect(a.order).to.equal(0);
      expect(b.order).to.equal(1);
    });

    it('creates a big-number widget with an empty body and value/unit in frontmatter', async () => {
      const root = await tmpRoot();
      const widget = await store.createWidget(root, 'default', {
        type: 'big-number',
        title: 'Messages',
        value: 12547,
        unit: 'messages',
      });
      expect(widget).to.deep.include({ type: 'big-number', value: 12547, unit: 'messages' });

      const raw = await fs.readFile(path.join(root, 'default', `${widget.id}.md`), 'utf8');
      const { data, body } = frontmatter.parse(raw);
      expect(data).to.deep.include({ value: 12547, unit: 'messages' });
      expect(body.trim()).to.equal('');
    });

    it('creates a big-number widget with no value as absent, not zero', async () => {
      const root = await tmpRoot();
      const widget = await store.createWidget(root, 'default', {
        type: 'big-number',
        title: 'Open questions',
      });
      expect(widget.value).to.equal(undefined);

      const raw = await fs.readFile(path.join(root, 'default', `${widget.id}.md`), 'utf8');
      const { data } = frontmatter.parse(raw);
      expect(data).to.not.have.property('value');
    });

    it('creates a line-graph widget with its CSV Body stored as the file body', async () => {
      const root = await tmpRoot();
      const csv = 'label,value\n09:00,120\n09:05,135';
      const widget = await store.createWidget(root, 'default', {
        type: 'line-graph',
        title: 'Response time',
        data: csv,
        color: '#ff0000',
      });
      expect(widget).to.deep.include({ type: 'line-graph', data: csv, color: '#ff0000' });

      const raw = await fs.readFile(path.join(root, 'default', `${widget.id}.md`), 'utf8');
      const { data, body } = frontmatter.parse(raw);
      expect(data).to.deep.include({ color: '#ff0000' });
      expect(body.trim()).to.equal(csv);
    });

    it('creates a pie-graph widget with its CSV Body stored as the file body', async () => {
      const root = await tmpRoot();
      const csv = 'label,value\nQuery,30\nAnalysis,25';
      const widget = await store.createWidget(root, 'default', {
        type: 'pie-graph',
        title: 'Agent usage',
        data: csv,
        colors: ['#111111', '#222222'],
      });
      expect(widget).to.deep.include({
        type: 'pie-graph',
        data: csv,
        colors: ['#111111', '#222222'],
      });

      const raw = await fs.readFile(path.join(root, 'default', `${widget.id}.md`), 'utf8');
      const { data, body } = frontmatter.parse(raw);
      expect(data).to.deep.include({ colors: ['#111111', '#222222'] });
      expect(body.trim()).to.equal(csv);
    });
  });

  describe('updateWidget', () => {
    it('updates content without renaming the file or changing order', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Original',
        content: 'x',
      });
      const updated = await store.updateWidget(root, 'default', created.id, {
        type: 'markdown',
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
        await store.updateWidget(root, 'default', 'does-not-exist', {
          type: 'markdown',
          title: 'x',
          content: 'y',
        });
        expect.fail('expected updateWidget to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(store.WidgetNotFoundError);
      }
    });

    it('updates a big-number widget value/unit', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'big-number',
        title: 'Count',
        value: 1,
      });
      const updated = await store.updateWidget(root, 'default', created.id, {
        type: 'big-number',
        title: 'Count',
        value: 2,
        unit: 'things',
      });
      expect(updated).to.deep.include({ value: 2, unit: 'things' });
    });

    it('updates a line-graph widget CSV Body', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'line-graph',
        title: 'CPU',
        data: 'label,value\n09:00,1',
      });
      const updated = await store.updateWidget(root, 'default', created.id, {
        type: 'line-graph',
        title: 'CPU',
        data: 'label,value\n09:00,1\n09:05,2',
      });
      expect(updated.data).to.equal('label,value\n09:00,1\n09:05,2');
    });
  });

  describe('updateWidgetRaw', () => {
    it('writes the raw content verbatim with no validation', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'x',
      });
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
      const created = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'x',
      });
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
      await store.createWidget(root, 'default', { type: 'markdown', title: 'Mine', content: 'x' });
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
