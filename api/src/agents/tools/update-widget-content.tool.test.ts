import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import type { AppBroadcastEvent } from '@tkottke90/llm-common-types/chat';
import { registerBroadcastClient, unregisterBroadcastClient } from '../../services/broadcast.js';
import {
  createWidgetHandler,
  createDashboardHandler,
} from '../../routes/v1/dashboards.handlers.js';
import { makeUpdateWidgetContentTool } from './update-widget-content.tool.js';

describe('agents/tools/update-widget-content', () => {
  let root: string;
  let received: AppBroadcastEvent[];
  const writer = (e: AppBroadcastEvent) => received.push(e);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'update-widget-content-tool-test-'));
    received = [];
    registerBroadcastClient(writer);
  });

  afterEach(() => {
    unregisterBroadcastClient(writer);
    rmSync(root, { recursive: true, force: true });
  });

  it('updates one field of an existing widget, leaving its other fields and title untouched [unit]', async () => {
    const created = await createWidgetHandler(root, 'default', {
      type: 'big-number',
      title: 'Disk space',
      value: 50,
      unit: '%',
    });
    if (!created.ok) throw new Error('setup failed');

    const tool = makeUpdateWidgetContentTool({ dashboardRoot: root });
    const result = await tool.invoke({ widgetId: created.data.id, content: { value: 87 } });

    expect(result).to.include(`Updated widget "${created.data.id}"`);
    expect(received).to.have.length(2); // create + content update
    const latest = received[1] as { type: 'widget_updated'; widget: { value?: number } };
    expect(latest.widget.value).to.equal(87);
  });

  it('stamps source "agent" and accepts a maintainer label [unit]', async () => {
    const created = await createWidgetHandler(root, 'default', {
      type: 'markdown',
      title: 'Disk check',
      content: 'a',
    });
    if (!created.ok) throw new Error('setup failed');

    const tool = makeUpdateWidgetContentTool({ dashboardRoot: root });
    await tool.invoke({
      widgetId: created.data.id,
      content: { content: 'b', maintainer: 'check-disk-space.sh' },
    });

    const latest = received[received.length - 1] as {
      type: 'widget_updated';
      widget: { source: string; maintainer?: string };
    };
    expect(latest.widget.source).to.equal('agent');
    expect(latest.widget.maintainer).to.equal('check-disk-space.sh');
  });

  it('returns a descriptive string instead of throwing for an unknown widget id [unit]', async () => {
    const created = await createWidgetHandler(root, 'default', {
      type: 'big-number',
      title: 'Count',
      value: 1,
    });
    if (!created.ok) throw new Error('setup failed');

    const tool = makeUpdateWidgetContentTool({ dashboardRoot: root });
    const result = await tool.invoke({ widgetId: 'does-not-exist', content: { value: 1 } });
    expect(result).to.include('Widget not updated');
  });

  it('returns a descriptive string instead of throwing for an invalid field value [unit]', async () => {
    const created = await createWidgetHandler(root, 'default', {
      type: 'big-number',
      title: 'Count',
      value: 1,
    });
    if (!created.ok) throw new Error('setup failed');

    const tool = makeUpdateWidgetContentTool({ dashboardRoot: root });
    const result = await tool.invoke({
      widgetId: created.data.id,
      content: { value: 'not-a-number' },
    });
    expect(result).to.include('Widget not updated');
  });

  it("resolves an omitted dashboardId to the sole existing dashboard's real id [unit]", async () => {
    const created = await createWidgetHandler(root, 'default', {
      type: 'big-number',
      title: 'Count',
      value: 1,
    });
    if (!created.ok) throw new Error('setup failed');

    const tool = makeUpdateWidgetContentTool({ dashboardRoot: root });
    const result = await tool.invoke({ widgetId: created.data.id, content: { value: 2 } });
    expect(result).to.include('Updated widget');
  });

  it('resolves an omitted dashboardId to the sole dashboard even when it is not "default" [unit]', async () => {
    const dashboard = await createDashboardHandler(root, { name: 'Ops' });
    if (!dashboard.ok) throw new Error('setup failed');
    const created = await createWidgetHandler(root, dashboard.data.id, {
      type: 'big-number',
      title: 'Count',
      value: 1,
    });
    if (!created.ok) throw new Error('setup failed');

    const tool = makeUpdateWidgetContentTool({ dashboardRoot: root });
    const result = await tool.invoke({ widgetId: created.data.id, content: { value: 2 } });

    expect(result).to.include(`Updated widget "${created.data.id}"`);
  });

  it('returns a validation error pointing at the Target Snippet when more than one dashboard exists and dashboardId is omitted [unit]', async () => {
    const created = await createWidgetHandler(root, 'default', {
      type: 'big-number',
      title: 'Count',
      value: 1,
    });
    if (!created.ok) throw new Error('setup failed');
    const secondDashboard = await createDashboardHandler(root, { name: 'Second' });
    if (!secondDashboard.ok) throw new Error('setup failed');

    const tool = makeUpdateWidgetContentTool({ dashboardRoot: root });
    const result = await tool.invoke({ widgetId: created.data.id, content: { value: 2 } });

    expect(result).to.include('dashboardId is required');
    expect(result).to.include('Dashboard Widget Target Snippet');
  });

  it('returns a validation error when no dashboards exist and dashboardId is omitted [unit]', async () => {
    const tool = makeUpdateWidgetContentTool({ dashboardRoot: root });
    const result = await tool.invoke({ widgetId: 'whatever', content: { value: 1 } });

    expect(result).to.include('No dashboards exist yet');
    expect(result).to.include('Dashboard Widget Target Snippet');
  });
});
