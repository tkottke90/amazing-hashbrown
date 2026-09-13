import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import { bootToolSettingsStore, getToolSettingsStore } from '../services/tool-settings-store.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import { resolveEffectiveToolIds, ALWAYS_ON_TOOL_IDS } from './tool-access.js';
import type { ToolEntry } from '../config/env.js';

// resolveEffectiveToolIds() reads two module-level singleton stores
// (getThreadStore()/getToolSettingsStore()) rather than taking them as
// parameters, so this test boots real ones against a throwaway db — same
// idiom as thread-store.test.ts/tool-settings-store.test.ts, just via the
// boot*Store() functions instead of `new`. Its config.yaml half (toolsConfig)
// is injected directly as a plain object, per tool-config.ts's own
// testability rationale — no real config.yaml file needed.
describe('agents/tool-access', () => {
  let dir: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-access-test-'));
    db = openDatabase(join(dir, 'test.db'));
    bootThreadStore(db);
    bootToolSettingsStore(db);
    getToolSettingsStore().seedCatalogDefaults(TOOL_CATALOG);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ALWAYS_ON_TOOL_IDS contains every wiki tool and complete_task', () => {
    expect(ALWAYS_ON_TOOL_IDS.has('wiki_search')).to.equal(true);
    expect(ALWAYS_ON_TOOL_IDS.has('complete_task')).to.equal(true);
    expect(ALWAYS_ON_TOOL_IDS.has('web_fetch')).to.equal(false);
  });

  it('a non-customized thread uses live global defaults plus alwaysOn tools', () => {
    getThreadStore().upsertThreadOnFirstMessage('t1', 'hi');
    const toolsConfig: Record<string, ToolEntry> = {
      shell_exec: { defaultInclude: { chat: false } },
    };

    const { customized, toolIds } = resolveEffectiveToolIds('t1', toolsConfig);
    expect(customized).to.equal(false);
    expect(toolIds.has('web_fetch')).to.equal(true);
    expect(toolIds.has('shell_exec')).to.equal(false);
    expect(toolIds.has('wiki_search')).to.equal(true);
  });

  it('a customized thread uses its own snapshot plus alwaysOn tools, ignoring global defaultInclude', () => {
    getThreadStore().upsertThreadOnFirstMessage('t2', 'hi');
    getToolSettingsStore().setThreadTools('t2', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t2');

    const { customized, toolIds } = resolveEffectiveToolIds('t2', {});
    expect(customized).to.equal(true);
    expect(toolIds.has('shell_exec')).to.equal(true);
    expect(toolIds.has('web_fetch')).to.equal(false);
    expect(toolIds.has('wiki_search')).to.equal(true);
  });

  it("a customized thread's selection drops a tool disabled globally after the snapshot was taken", () => {
    getThreadStore().upsertThreadOnFirstMessage('t2b', 'hi');
    getToolSettingsStore().setThreadTools('t2b', ['shell_exec', 'web_fetch']);
    getThreadStore().markThreadToolsCustomized('t2b');
    const toolsConfig: Record<string, ToolEntry> = { shell_exec: { enabled: false } };

    const { toolIds } = resolveEffectiveToolIds('t2b', toolsConfig);
    expect(toolIds.has('shell_exec')).to.equal(false);
    expect(toolIds.has('web_fetch')).to.equal(true);
  });

  it('resetting a customized thread reverts it to live global defaults', () => {
    getThreadStore().upsertThreadOnFirstMessage('t3', 'hi');
    getToolSettingsStore().setThreadTools('t3', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t3');
    getToolSettingsStore().resetThreadTools('t3');
    getThreadStore().resetThreadToolsCustomization('t3');

    const { customized, toolIds } = resolveEffectiveToolIds('t3', {});
    expect(customized).to.equal(false);
    expect(toolIds.has('web_fetch')).to.equal(true);
  });

  it('a wiki tool stays available even if its config.yaml entry is somehow disabled', () => {
    getThreadStore().upsertThreadOnFirstMessage('t4', 'hi');
    // alwaysOn forcing lives in tool-config.ts's resolveToolSettings(), not
    // this file — this proves the ALWAYS_ON union here is real
    // defense-in-depth on top of that, not the only thing enforcing it.
    const toolsConfig: Record<string, ToolEntry> = {
      wiki_search: { enabled: false, defaultInclude: { chat: false } },
    };

    const { toolIds } = resolveEffectiveToolIds('t4', toolsConfig);
    expect(toolIds.has('wiki_search')).to.equal(true);
  });
});
