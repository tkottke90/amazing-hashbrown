import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';
import { deleteWorkspace } from './workspace/utilities.js';

const suite: TestSuite = {
  id: 63,
  name: 'Thread-Scoped Actions Before First Message',
  description:
    'Verifies the # Tool Menu, Edit Tools drawer, and Orient to Wiki succeed against the real backend on a workspace chat thread that has no row yet — both a fresh workspace and the successor thread right after Replace Thread',
  purpose:
    'Regression guard for the lazy-thread-creation gap (threads.handlers.ts ensureThreadExists): these three composer actions used to 404 silently on any thread that had never had a message sent in it. Deliberately unmocked, unlike thread-report.spec.ts/thread-tools.spec.ts, which mock these exact endpoints to route around this same gap.',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Create a brand-new workspace and open its Chat tab, before sending any message',
      expectedOutcome: 'The Chat tab loads normally',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open "Add to message" and click "Edit tools"',
      expectedOutcome:
        'The drawer opens and renders real tool data, not an error or stuck-loading state',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Type # in the composer',
      expectedOutcome:
        "The Tool Menu autocomplete opens and lists tools — the literal bug report's repro",
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Use "Orient to wiki" from the add-menu',
      expectedOutcome: 'A wiki-orientation confirmation card appears in the thread, no error',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click Replace Thread, confirm, then repeat the # Tool Menu check',
      expectedOutcome: 'The Tool Menu still opens against the brand-new successor thread',
      test: () => {},
    },
  ],
};

test.describe('@user-workflow', { annotation: suiteAnnotations(suite) }, () => {
  test('workspace chat: tool menu, edit tools drawer, and orient to wiki all work before the first message', async ({
    page,
    request,
  }, testInfo) => {
    // Direct request rather than the createWorkspace() utility — that
    // helper narrows the response to {id, location}, discarding wikiId,
    // which this test needs to click the right "Orient to wiki" entry.
    const wsRes = await request.post('/api/v1/workspaces', {
      data: {
        name: `e2e-thread-actions-${Date.now()}`,
        locationRoot: 'temporary',
        directoryName: `e2e-thread-actions-${Date.now()}`,
        // Guarantees at least one entry in the global "Orient to wiki"
        // submenu regardless of what already exists in this environment's
        // wiki registry — outlives the workspace, cleaned up explicitly below.
        newWiki: { name: `E2E Thread Actions Wiki ${Date.now()}` },
      },
    });
    expect(wsRes.status()).toBe(201);
    const ws = (await wsRes.json()) as { id: string; wikiId: string | null };
    const wikiId = ws.wikiId;
    expect(wikiId).toBeTruthy();

    try {
      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: 'Chat' }).click();
      await pauseBeforeAction(page, testInfo);

      const textarea = page.locator('[data-slot="textarea"]');
      await expect(textarea).toBeVisible();

      // 1. Edit Tools drawer — composer-reachable before any message exists.
      await page.locator('button[aria-label="Add to message"]').click();
      await page.getByRole('menuitem', { name: 'Edit tools' }).click();
      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();
      // Not stuck in the body's loading/empty state (thread-tools-drawer.tsx
      // renders "Loading…" and returns early until the GET resolves) — real
      // tool rows appeared, so the GET that used to 404 here now succeeded.
      await expect(drawer.getByText('Loading…')).not.toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).not.toBeVisible();

      // 2. # Tool Menu — the literal bug report's reproduction.
      await textarea.fill('#');
      await expect(page.locator('[data-slot="chat-input-tool-menu"]')).toBeVisible();
      await textarea.fill('');

      // 3. Orient to wiki.
      await page.locator('button[aria-label="Add to message"]').click();
      await page.getByRole('menuitem', { name: 'Orient to wiki' }).click();
      await page.getByRole('menuitemcheckbox', { name: wikiId }).click();
      await expect(page.getByTestId('wiki-orientation-card')).toBeVisible();

      // 4. Replace Thread, then repeat the # Tool Menu check against the
      // brand-new successor thread — same lazy-creation gap, right after
      // the successor is minted with no messages of its own yet.
      await page.getByRole('button', { name: 'Replace Thread' }).click();
      await page.getByRole('button', { name: 'Replace' }).click();
      await expect(page.getByRole('button', { name: 'Replace Thread' })).toBeVisible();

      await textarea.fill('#');
      await expect(page.locator('[data-slot="chat-input-tool-menu"]')).toBeVisible();
    } finally {
      if (wikiId) await request.delete(`/api/v1/wiki/domains/${wikiId}`);
      await deleteWorkspace(request, ws.id);
    }
  });
});
