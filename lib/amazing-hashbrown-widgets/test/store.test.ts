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
      await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'First',
        source: 'manual',
        content: 'a',
      });
      await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Second',
        source: 'manual',
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
      await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Good',
        source: 'manual',
        content: 'a',
      });
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
        source: 'manual',
        data: 'label,value\nA,1\nB,2',
      });
      await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Md',
        source: 'manual',
        content: 'hi',
      });
      await store.createWidget(root, 'default', {
        type: 'big-number',
        title: 'Num',
        source: 'manual',
        value: 5,
      });
      await store.createWidget(root, 'default', {
        type: 'line-graph',
        title: 'Line',
        source: 'manual',
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

    it('attaches updatedAt derived from the file mtime (ADR-0006)', async () => {
      const root = await tmpRoot();
      const before = Date.now();
      await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Fresh',
        source: 'manual',
        content: 'a',
      });
      const [result] = await store.listWidgets(root, 'default');
      expect(result?.status).to.equal('ok');
      if (result?.status === 'ok') {
        const updatedAt = new Date(result.widget.updatedAt).getTime();
        expect(updatedAt).to.be.a('number');
        expect(updatedAt).to.be.at.least(before - 1000);
      }
    });
  });

  describe('loadWidget', () => {
    it('returns null for a missing widget', async () => {
      const root = await tmpRoot();
      expect(await store.loadWidget(root, 'default', 'does-not-exist')).to.equal(null);
    });

    it('returns the widget with a fresh updatedAt for an existing one', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'big-number',
        title: 'Count',
        source: 'manual',
        value: 1,
      });
      const loaded = await store.loadWidget(root, 'default', created.id);
      expect(loaded).to.not.equal(null);
      expect(loaded).to.deep.include({ id: created.id, type: 'big-number', value: 1 });
      expect(new Date(loaded!.updatedAt).getTime()).to.be.a('number');
    });

    it('returns null for a file that fails to parse/validate', async () => {
      const root = await tmpRoot();
      const dir = path.join(root, 'default');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'broken.md'),
        '---\ntitle: [unterminated\n---\nBody',
        'utf8',
      );
      expect(await store.loadWidget(root, 'default', 'broken')).to.equal(null);
    });
  });

  describe('createWidget', () => {
    it('slugifies the title into the filename', async () => {
      const root = await tmpRoot();
      const widget = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Getting Started!',
        source: 'manual',
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
        source: 'manual',
        content: 'a',
      });
      const second = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        source: 'manual',
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
        source: 'manual',
        content: 'x',
      });
      const b = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'B',
        source: 'manual',
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
        source: 'manual',
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
        source: 'manual',
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
        source: 'manual',
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
        source: 'manual',
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

    it('returns a fresh, parseable updatedAt', async () => {
      const root = await tmpRoot();
      const before = Date.now();
      const widget = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Fresh',
        source: 'manual',
        content: 'x',
      });
      expect(new Date(widget.updatedAt).getTime()).to.be.at.least(before - 1000);
    });

    it('persists source and maintainer into frontmatter', async () => {
      const root = await tmpRoot();
      const widget = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Disk check',
        source: 'agent',
        maintainer: 'check-disk-space.sh',
        content: 'x',
      });
      expect(widget).to.deep.include({ source: 'agent', maintainer: 'check-disk-space.sh' });

      const raw = await fs.readFile(path.join(root, 'default', `${widget.id}.md`), 'utf8');
      const { data } = frontmatter.parse(raw);
      expect(data).to.deep.include({ source: 'agent', maintainer: 'check-disk-space.sh' });
    });

    it('sets Widget Size to the type minimum for each widget type', async () => {
      const root = await tmpRoot();
      const markdown = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Md',
        source: 'manual',
        content: 'x',
      });
      const bigNumber = await store.createWidget(root, 'default', {
        type: 'big-number',
        title: 'Num',
        source: 'manual',
      });
      const lineGraph = await store.createWidget(root, 'default', {
        type: 'line-graph',
        title: 'Line',
        source: 'manual',
        data: 'label,value\nA,1',
      });
      const pieGraph = await store.createWidget(root, 'default', {
        type: 'pie-graph',
        title: 'Pie',
        source: 'manual',
        data: 'label,value\nA,1',
      });
      const spacer = await store.createWidget(root, 'default', {
        type: 'spacer',
        title: 'Spacer',
        source: 'manual',
      });
      expect(markdown).to.deep.include({ w: 3, h: 2 });
      expect(bigNumber).to.deep.include({ w: 2, h: 2 });
      expect(lineGraph).to.deep.include({ w: 4, h: 3 });
      expect(pieGraph).to.deep.include({ w: 4, h: 3 });
      expect(spacer).to.deep.include({ w: 1, h: 1 });
    });

    it('creates a spacer widget with an empty body, same shape big-number uses', async () => {
      const root = await tmpRoot();
      const widget = await store.createWidget(root, 'default', {
        type: 'spacer',
        title: 'Spacer',
        source: 'manual',
      });
      expect(widget).to.deep.include({ type: 'spacer', w: 1, h: 1 });

      const raw = await fs.readFile(path.join(root, 'default', `${widget.id}.md`), 'utf8');
      const { body } = frontmatter.parse(raw);
      expect(body.trim()).to.equal('');
    });
  });

  describe('updateWidget', () => {
    it('updates content without renaming the file or changing order', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Original',
        source: 'manual',
        content: 'x',
      });
      const updated = await store.updateWidget(root, 'default', created.id, {
        type: 'markdown',
        title: 'Changed Title',
        source: 'manual',
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
          source: 'manual',
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
        source: 'manual',
        value: 1,
      });
      const updated = await store.updateWidget(root, 'default', created.id, {
        type: 'big-number',
        title: 'Count',
        source: 'manual',
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
        source: 'manual',
        data: 'label,value\n09:00,1',
      });
      const updated = await store.updateWidget(root, 'default', created.id, {
        type: 'line-graph',
        title: 'CPU',
        source: 'manual',
        data: 'label,value\n09:00,1\n09:05,2',
      });
      expect(updated.data).to.equal('label,value\n09:00,1\n09:05,2');
    });

    it('returns a fresh, parseable updatedAt', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Original',
        source: 'manual',
        content: 'x',
      });
      const before = Date.now();
      const updated = await store.updateWidget(root, 'default', created.id, {
        type: 'markdown',
        title: 'Original',
        source: 'agent',
        content: 'new content',
      });
      expect(new Date(updated.updatedAt).getTime()).to.be.at.least(before - 1000);
    });

    it('persists whatever source/maintainer the caller supplies, unmodified', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Disk check',
        source: 'manual',
        content: 'x',
      });
      const updated = await store.updateWidget(root, 'default', created.id, {
        type: 'markdown',
        title: 'Disk check',
        source: 'agent',
        maintainer: 'check-disk-space.sh',
        content: 'new content',
      });
      expect(updated).to.deep.include({ source: 'agent', maintainer: 'check-disk-space.sh' });
    });

    it('preserves the existing Widget Size when no size is supplied', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'big-number',
        title: 'Count',
        source: 'manual',
        value: 1,
      });
      expect(created).to.deep.include({ w: 2, h: 2 });
      const updated = await store.updateWidget(root, 'default', created.id, {
        type: 'big-number',
        title: 'Count',
        source: 'manual',
        value: 2,
      });
      expect(updated).to.deep.include({ w: 2, h: 2 });
    });

    it('overwrites Widget Size when a size is supplied (resize)', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'big-number',
        title: 'Count',
        source: 'manual',
        value: 1,
      });
      const resized = await store.updateWidget(
        root,
        'default',
        created.id,
        { type: 'big-number', title: 'Count', source: 'manual', value: 1 },
        { w: 6, h: 4 },
      );
      expect(resized).to.deep.include({ w: 6, h: 4 });
    });
  });

  describe('reorderWidget', () => {
    async function createThree(root: string): Promise<[string, string, string]> {
      const a = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'A',
        source: 'manual',
        content: 'a',
      });
      const b = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'B',
        source: 'manual',
        content: 'b',
      });
      const c = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'C',
        source: 'manual',
        content: 'c',
      });
      return [a.id, b.id, c.id];
    }

    async function orderedIds(root: string): Promise<string[]> {
      const results = await store.listWidgets(root, 'default');
      return results
        .filter((r): r is { status: 'ok'; widget: { id: string } } => r.status === 'ok')
        .map((r) => r.widget.id);
    }

    it('is a no-op when movedId equals targetId', async () => {
      const root = await tmpRoot();
      const [a] = await createThree(root);
      const before = await orderedIds(root);
      const changed = await store.reorderWidget(root, 'default', a, a);
      expect(changed).to.deep.equal([]);
      expect(await orderedIds(root)).to.deep.equal(before);
    });

    it('moves a widget forward, into the middle of the sequence', async () => {
      const root = await tmpRoot();
      const a = (
        await store.createWidget(root, 'default', {
          type: 'markdown',
          title: 'A',
          source: 'manual',
          content: 'a',
        })
      ).id;
      const b = (
        await store.createWidget(root, 'default', {
          type: 'markdown',
          title: 'B',
          source: 'manual',
          content: 'b',
        })
      ).id;
      const c = (
        await store.createWidget(root, 'default', {
          type: 'markdown',
          title: 'C',
          source: 'manual',
          content: 'c',
        })
      ).id;
      const d = (
        await store.createWidget(root, 'default', {
          type: 'markdown',
          title: 'D',
          source: 'manual',
          content: 'd',
        })
      ).id;
      // Moving A to immediately before C lands it between B and C, not at the end.
      await store.reorderWidget(root, 'default', a, c);
      expect(await orderedIds(root)).to.deep.equal([b, a, c, d]);
    });

    it('moves a widget backward in the sequence', async () => {
      const root = await tmpRoot();
      const [a, b, c] = await createThree(root);
      await store.reorderWidget(root, 'default', c, a);
      expect(await orderedIds(root)).to.deep.equal([c, a, b]);
    });

    it('moves a widget to the end of the sequence', async () => {
      const root = await tmpRoot();
      const [a, b, c] = await createThree(root);
      await store.reorderWidget(root, 'default', a, c);
      // moving A to immediately before C (which is last) lands it second
      expect(await orderedIds(root)).to.deep.equal([b, a, c]);
    });

    it('returns only the widgets whose order actually changed', async () => {
      const root = await tmpRoot();
      const a = (
        await store.createWidget(root, 'default', {
          type: 'markdown',
          title: 'A',
          source: 'manual',
          content: 'a',
        })
      ).id;
      const b = (
        await store.createWidget(root, 'default', {
          type: 'markdown',
          title: 'B',
          source: 'manual',
          content: 'b',
        })
      ).id;
      const c = (
        await store.createWidget(root, 'default', {
          type: 'markdown',
          title: 'C',
          source: 'manual',
          content: 'c',
        })
      ).id;
      await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'D',
        source: 'manual',
        content: 'd',
      });
      // Moving A to immediately before C shifts only A and B; C and D keep
      // their original order values, so only 2 of the 4 widgets are written.
      const changed = await store.reorderWidget(root, 'default', a, c);
      const changedIds = changed.map((w) => w.id).sort();
      expect(changedIds).to.deep.equal([a, b].sort());
      expect(changed.find((w) => w.id === b)?.order).to.equal(0);
      expect(changed.find((w) => w.id === a)?.order).to.equal(1);
    });

    it('throws WidgetNotFoundError and writes nothing for an unknown movedId', async () => {
      const root = await tmpRoot();
      await createThree(root);
      const before = await orderedIds(root);
      try {
        await store.reorderWidget(root, 'default', 'does-not-exist', before[0]!);
        expect.fail('expected reorderWidget to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(store.WidgetNotFoundError);
      }
      expect(await orderedIds(root)).to.deep.equal(before);
    });

    it('throws WidgetNotFoundError and writes nothing for an unknown targetWidgetId', async () => {
      const root = await tmpRoot();
      await createThree(root);
      const before = await orderedIds(root);
      try {
        await store.reorderWidget(root, 'default', before[0]!, 'does-not-exist');
        expect.fail('expected reorderWidget to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(store.WidgetNotFoundError);
      }
      expect(await orderedIds(root)).to.deep.equal(before);
    });
  });

  describe('updateWidgetRaw', () => {
    it('writes the raw content verbatim with no validation', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        source: 'manual',
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
        source: 'manual',
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
      expect(results.every((r) => r.status === 'ok' && r.widget.source === 'manual')).to.equal(
        true,
      );
    });

    it('is a no-op when the dashboard folder already has widgets', async () => {
      const root = await tmpRoot();
      await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'Mine',
        source: 'manual',
        content: 'x',
      });
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

    it('rejects an unsafe movedId/targetId passed to reorderWidget', async () => {
      const root = await tmpRoot();
      const created = await store.createWidget(root, 'default', {
        type: 'markdown',
        title: 'A',
        source: 'manual',
        content: 'a',
      });
      try {
        await store.reorderWidget(root, 'default', created.id, '../escape');
        expect.fail('expected reorderWidget to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(store.WidgetNotFoundError);
      }
    });
  });
});
