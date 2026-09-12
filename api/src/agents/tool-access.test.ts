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

// resolveEffectiveToolIds() reads two module-level singleton stores
// (getThreadStore()/getToolSettingsStore()) rather than taking them as
// parameters, so this test boots real ones against a throwaway db — same
// idiom as thread-store.test.ts/tool-settings-store.test.ts, just via the
// boot*Store() functions instead of `new`.
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
    getToolSettingsStore().patch('shell_exec', { defaultInclude: false });

    const { customized, toolIds } = resolveEffectiveToolIds('t1');
    expect(customized).to.equal(false);
    expect(toolIds.has('web_fetch')).to.equal(true);
    expect(toolIds.has('shell_exec')).to.equal(false);
    expect(toolIds.has('wiki_search')).to.equal(true);
  });

  it('a customized thread uses its own snapshot plus alwaysOn tools, ignoring global defaultInclude', () => {
    getThreadStore().upsertThreadOnFirstMessage('t2', 'hi');
    getToolSettingsStore().setThreadTools('t2', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t2');

    const { customized, toolIds } = resolveEffectiveToolIds('t2');
    expect(customized).to.equal(true);
    expect(toolIds.has('shell_exec')).to.equal(true);
    expect(toolIds.has('web_fetch')).to.equal(false);
    expect(toolIds.has('wiki_search')).to.equal(true);
  });

  it('resetting a customized thread reverts it to live global defaults', () => {
    getThreadStore().upsertThreadOnFirstMessage('t3', 'hi');
    getToolSettingsStore().setThreadTools('t3', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t3');
    getToolSettingsStore().resetThreadTools('t3');
    getThreadStore().resetThreadToolsCustomization('t3');

    const { customized, toolIds } = resolveEffectiveToolIds('t3');
    expect(customized).to.equal(false);
    expect(toolIds.has('web_fetch')).to.equal(true);
  });

  it('a wiki tool stays available even if its own row is somehow disabled', () => {
    getThreadStore().upsertThreadOnFirstMessage('t4', 'hi');
    // patch() itself refuses this (category 'wiki'); simulate a bad row via
    // direct SQL to prove the ALWAYS_ON union is real defense-in-depth, not
    // just "patch() happens to refuse it so it never comes up".
    db.prepare(`UPDATE tool_settings SET enabled = 0 WHERE tool_id = 'wiki_search'`).run();

    const { toolIds } = resolveEffectiveToolIds('t4');
    expect(toolIds.has('wiki_search')).to.equal(true);
  });
});
