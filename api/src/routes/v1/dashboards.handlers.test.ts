import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import type { AppBroadcastEvent } from '@tkottke90/llm-common-types/chat';
import { registerBroadcastClient, unregisterBroadcastClient } from '../../services/broadcast.js';
import {
  listWidgetsHandler,
  createWidgetHandler,
  updateWidgetHandler,
  reorderWidgetHandler,
  updateWidgetContentHandler,
  updateWidgetRawHandler,
  deleteWidgetHandler,
  listDashboardsHandler,
  createDashboardHandler,
  updateDashboardHandler,
  deleteDashboardHandler,
} from './dashboards.handlers.js';
import path from 'node:path';

describe('routes/v1/dashboards.handlers', () => {
  let root: string;
  let broadcastedEvents: AppBroadcastEvent[];
  const captureBroadcast = (event: AppBroadcastEvent) => broadcastedEvents.push(event);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dashboards-handlers-test-'));
    broadcastedEvents = [];
    registerBroadcastClient(captureBroadcast);
  });

  afterEach(() => {
    unregisterBroadcastClient(captureBroadcast);
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
        expect(result.data.source).to.equal('manual');
      }
    });

    it('broadcasts widget_updated on a successful create [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Welcome',
        content: '# Hello',
      });
      if (!result.ok) throw new Error('setup failed');
      expect(broadcastedEvents).to.have.length(1);
      expect(broadcastedEvents[0]).to.deep.equal({
        type: 'widget_updated',
        dashboardId: 'default',
        widget: result.data,
      });
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

    it('creates a spacer widget with a fixed title, ignoring any caller-supplied title [unit]', async () => {
      const result = await createWidgetHandler(root, 'default', {
        type: 'spacer',
        // SpacerWidgetInputSchema has no title key, so even if a caller
        // somehow smuggled one in, zod strips it before this ever runs —
        // this body is deliberately as bare as the UI drawer ever sends.
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.type).to.equal('spacer');
        expect(result.data.title).to.equal('Spacer');
        expect(result.data).to.deep.include({ w: 1, h: 1 });
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
      if (result.ok) {
        expect(result.data.title).to.equal('New Title');
        expect(result.data.source).to.equal('manual');
      }
    });

    it('broadcasts widget_updated on a successful update [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Tip',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');
      broadcastedEvents = [];

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'markdown',
        title: 'New Title',
        content: 'b',
      });
      if (!result.ok) throw new Error('setup failed');
      expect(broadcastedEvents).to.have.length(1);
      expect(broadcastedEvents[0]).to.deep.equal({
        type: 'widget_updated',
        dashboardId: 'default',
        widget: result.data,
      });
    });

    it('preserves an existing maintainer across a full-replace edit (D15) [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Disk check',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');
      const viaContent = await updateWidgetContentHandler(
        root,
        'default',
        created.data.id,
        { maintainer: 'check-disk-space.sh' },
        'agent',
      );
      if (!viaContent.ok) throw new Error('setup failed');

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'markdown',
        title: 'Disk check (renamed)',
        content: 'b',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.source).to.equal('manual');
        expect(result.data.maintainer).to.equal('check-disk-space.sh');
      }
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

    it('persists Widget Size when both w and h are supplied (resize) [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Count',
        value: 1,
      });
      if (!created.ok) throw new Error('setup failed');
      expect(created.data).to.deep.include({ w: 2, h: 2 });

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'big-number',
        title: 'Count',
        value: 1,
        w: 6,
        h: 4,
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.include({ w: 6, h: 4 });
    });

    it('preserves Widget Size when w/h are omitted, the drawer edit path [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Count',
        value: 1,
      });
      if (!created.ok) throw new Error('setup failed');
      const resized = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'big-number',
        title: 'Count',
        value: 1,
        w: 6,
        h: 4,
      });
      if (!resized.ok) throw new Error('setup failed');

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'big-number',
        title: 'Count renamed',
        value: 1,
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.include({ w: 6, h: 4 });
    });

    it('rejects a w below the type minimum with 400 [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Count',
        value: 1,
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'big-number',
        title: 'Count',
        value: 1,
        w: 1,
        h: 2,
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('resizes a spacer widget, keeping its title fixed at "Spacer" (D-preserve) [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', { type: 'spacer' });
      if (!created.ok) throw new Error('setup failed');
      expect(created.data).to.deep.include({ w: 1, h: 1 });

      const result = await updateWidgetHandler(root, 'default', created.data.id, {
        type: 'spacer',
        w: 3,
        h: 2,
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.include({ w: 3, h: 2, title: 'Spacer' });
      }
    });
  });

  describe('reorderWidgetHandler()', () => {
    it('reorders two widgets, returning only the ones whose order changed [unit]', async () => {
      const a = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'A',
        content: 'a',
      });
      const b = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'B',
        content: 'b',
      });
      if (!a.ok || !b.ok) throw new Error('setup failed');

      const result = await reorderWidgetHandler(root, 'default', b.data.id, {
        targetWidgetId: a.data.id,
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const ids = result.data.map((w) => w.id).sort();
        expect(ids).to.deep.equal([a.data.id, b.data.id].sort());
      }

      const list = await listWidgetsHandler(root, 'default');
      if (list.ok) {
        const ordered = list.data.map((r) => (r.status === 'ok' ? r.widget.id : null));
        expect(ordered).to.deep.equal([b.data.id, a.data.id]);
      }
    });

    it('returns an empty array and broadcasts nothing for a no-op reorder [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'A',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');
      broadcastedEvents = [];

      const result = await reorderWidgetHandler(root, 'default', created.data.id, {
        targetWidgetId: created.data.id,
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal([]);
      expect(broadcastedEvents).to.have.length(0);
    });

    it('broadcasts dashboard_reordered carrying every changed widget [unit]', async () => {
      const a = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'A',
        content: 'a',
      });
      const b = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'B',
        content: 'b',
      });
      if (!a.ok || !b.ok) throw new Error('setup failed');
      broadcastedEvents = [];

      const result = await reorderWidgetHandler(root, 'default', b.data.id, {
        targetWidgetId: a.data.id,
      });
      if (!result.ok) throw new Error('setup failed');
      expect(broadcastedEvents).to.have.length(1);
      expect(broadcastedEvents[0]).to.deep.equal({
        type: 'dashboard_reordered',
        dashboardId: 'default',
        widgets: result.data,
      });
    });

    it('returns 404 for an unknown movedId [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'A',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await reorderWidgetHandler(root, 'default', 'nope', {
        targetWidgetId: created.data.id,
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 404 for an unknown targetWidgetId [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'A',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await reorderWidgetHandler(root, 'default', created.data.id, {
        targetWidgetId: 'nope',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 for a missing targetWidgetId in the body [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'A',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await reorderWidgetHandler(root, 'default', created.data.id, {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });
  });

  describe('updateWidgetContentHandler()', () => {
    it('merges a single field, leaving title/subtitle/other fields untouched [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Disk space',
        subtitle: 'Root volume',
        value: 50,
        unit: '%',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetContentHandler(
        root,
        'default',
        created.data.id,
        { value: 87 },
        'agent',
      );
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.include({
          title: 'Disk space',
          subtitle: 'Root volume',
          value: 87,
          unit: '%',
        });
      }
    });

    it('returns 404 for a widget id that does not exist [unit]', async () => {
      const result = await updateWidgetContentHandler(
        root,
        'default',
        'nope',
        { value: 1 },
        'agent',
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 for a spacer widget, which has no content to update [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', { type: 'spacer' });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetContentHandler(
        root,
        'default',
        created.data.id,
        { maintainer: 'some-script.sh' },
        'agent',
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it("returns 400 for a value of the wrong type for the target widget's schema [unit]", async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Count',
        value: 1,
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetContentHandler(
        root,
        'default',
        created.data.id,
        { value: 'not-a-number' } as unknown as Record<string, unknown>,
        'agent',
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('ignores a field that belongs to a different widget type, like the drawer route does [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Count',
        value: 1,
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetContentHandler(
        root,
        'default',
        created.data.id,
        { colors: ['#111111'] } as unknown as Record<string, unknown>,
        'agent',
      );
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.type).to.equal('big-number');
        expect((result.data as { colors?: string[] }).colors).to.equal(undefined);
      }
    });

    it('returns 400 for malformed CSV on a line-graph widget [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'line-graph',
        title: 'CPU',
        data: 'label,value\n09:00,1',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetContentHandler(
        root,
        'default',
        created.data.id,
        { data: '09:00,1\n09:05,2' },
        'agent',
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('round-trips maintainer [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Disk check',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetContentHandler(
        root,
        'default',
        created.data.id,
        { content: 'b', maintainer: 'check-disk-space.sh' },
        'agent',
      );
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.maintainer).to.equal('check-disk-space.sh');
    });

    it('always stamps source "agent", ignoring any source key in the body (ADR-0005) [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'markdown',
        title: 'Disk check',
        content: 'a',
      });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateWidgetContentHandler(
        root,
        'default',
        created.data.id,
        { content: 'b', source: 'manual' } as unknown as Record<string, unknown>,
        'agent',
      );
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.source).to.equal('agent');
    });

    it('broadcasts widget_updated on a successful content update [unit]', async () => {
      const created = await createWidgetHandler(root, 'default', {
        type: 'big-number',
        title: 'Disk space',
        value: 50,
      });
      if (!created.ok) throw new Error('setup failed');
      broadcastedEvents = [];

      const result = await updateWidgetContentHandler(
        root,
        'default',
        created.data.id,
        { value: 87 },
        'agent',
      );
      if (!result.ok) throw new Error('setup failed');
      expect(broadcastedEvents).to.have.length(1);
      expect(broadcastedEvents[0]).to.deep.equal({
        type: 'widget_updated',
        dashboardId: 'default',
        widget: result.data,
      });
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

  describe('listDashboardsHandler()', () => {
    it('returns [] for an empty root [unit]', async () => {
      const result = await listDashboardsHandler(root);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal([]);
    });

    it('includes a derived path field equal to path.join(root, id) [unit]', async () => {
      const created = await createDashboardHandler(root, { name: 'Homelab' });
      if (!created.ok) throw new Error('setup failed');

      const result = await listDashboardsHandler(root);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.have.length(1);
        expect(result.data[0]?.path).to.equal(path.join(root, created.data.id));
      }
    });

    it('sorts by createdAt ascending [unit]', async () => {
      const first = await createDashboardHandler(root, { name: 'First' });
      const second = await createDashboardHandler(root, { name: 'Second' });
      if (!first.ok || !second.ok) throw new Error('setup failed');

      const result = await listDashboardsHandler(root);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.map((d) => d.id)).to.deep.equal([first.data.id, second.data.id]);
      }
    });
  });

  describe('createDashboardHandler()', () => {
    it('creates a dashboard with the given name, empty description, density compact [unit]', async () => {
      const result = await createDashboardHandler(root, { name: 'Research' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.name).to.equal('Research');
        expect(result.data.description).to.equal('');
        expect(result.data.density).to.equal('compact');
      }
    });

    it('starts with zero widgets [unit]', async () => {
      const created = await createDashboardHandler(root, { name: 'Research' });
      if (!created.ok) throw new Error('setup failed');

      const widgets = await listWidgetsHandler(root, created.data.id);
      expect(widgets.ok).to.equal(true);
      if (widgets.ok) expect(widgets.data).to.deep.equal([]);
    });

    it('rejects an empty/missing name with 400 [unit]', async () => {
      const result = await createDashboardHandler(root, { name: '' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });
  });

  describe('updateDashboardHandler()', () => {
    it('updates name only, preserving description/density [unit]', async () => {
      const created = await createDashboardHandler(root, { name: 'Original' });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateDashboardHandler(root, created.data.id, { name: 'Renamed' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.name).to.equal('Renamed');
        expect(result.data.description).to.equal(created.data.description);
        expect(result.data.density).to.equal(created.data.density);
      }
    });

    it('updates density to roomy [unit]', async () => {
      const created = await createDashboardHandler(root, { name: 'Original' });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateDashboardHandler(root, created.data.id, { density: 'roomy' });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.density).to.equal('roomy');
    });

    it('returns 404 for an unknown dashboard id [unit]', async () => {
      const result = await updateDashboardHandler(root, 'nope', { name: 'X' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 for an invalid density value [unit]', async () => {
      const created = await createDashboardHandler(root, { name: 'Original' });
      if (!created.ok) throw new Error('setup failed');

      const result = await updateDashboardHandler(root, created.data.id, {
        density: 'spacious',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });
  });

  describe('deleteDashboardHandler()', () => {
    it('deletes a dashboard when 2+ exist [unit]', async () => {
      const first = await createDashboardHandler(root, { name: 'First' });
      const second = await createDashboardHandler(root, { name: 'Second' });
      if (!first.ok || !second.ok) throw new Error('setup failed');

      const result = await deleteDashboardHandler(root, second.data.id);
      expect(result.ok).to.equal(true);

      const list = await listDashboardsHandler(root);
      if (list.ok) expect(list.data.map((d) => d.id)).to.deep.equal([first.data.id]);
    });

    it('returns 400 (delete-guard) when it is the only dashboard [unit]', async () => {
      const created = await createDashboardHandler(root, { name: 'Only' });
      if (!created.ok) throw new Error('setup failed');

      const result = await deleteDashboardHandler(root, created.data.id);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 404 for an unknown dashboard id [unit]', async () => {
      const result = await deleteDashboardHandler(root, 'nope');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });
  });
});
