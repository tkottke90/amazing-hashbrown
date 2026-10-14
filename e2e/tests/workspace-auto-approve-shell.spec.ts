import { test, expect, type Route, type APIRequestContext } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

// Covers the workspace-level "Auto" shell_exec auto-approve toggle — see
// docs/superpowers/specs/2026-10-13-workspace-shell-auto-approve-design.md.
// A live LLM would be needed to actually drive a real shell_exec call
// through the agent, so the "no approval card while Auto is on" and
// "approval card returns once Auto is off" scenarios simulate the before/
// after thread message state the same way live-task-events.spec.ts and
// hitl-shell-approval.spec.ts already do for other HITL-adjacent cases —
// see this package's AGENTS.md "Mocking API responses" section.
const suite: TestSuite = {
  id: 51,
  name: 'Workspace Shell Auto-Approve',
  description:
    "Verifies the workspace Chat tab's add-menu toggle and chip for shell_exec auto-approve, " +
    'and that a thread with no pending shell_approval message renders no approval card while ' +
    'one with a pending prompt does',
  purpose:
    'Defend the Auto-mode UI surface (toggle round-trips the real PATCH, chip visibility follows ' +
    'autoApproveShell) against regression, independent of whether a live LLM actually skips the ' +
    'approval interrupt (covered at the shell-executor/shell-exec-tool unit level instead)',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: "Open a workspace's Chat tab and toggle Auto-approve on via the add menu",
      expectedOutcome: 'The amber "Auto" chip appears next to the model chip',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action:
        'Load a workspace with autoApproveShell already on, whose thread has a completed ' +
        'shell_exec tool call and no pending prompt',
      expectedOutcome: 'No shell_approval approval card renders',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action:
        'Click the chip to toggle Auto off, then load a thread with a pending shell_approval prompt',
      expectedOutcome: 'The chip disappears and the Approve/Deny approval card renders',
      test: () => {},
    },
  ],
};

async function createWorkspace(
  request: APIRequestContext,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request.post('/api/v1/workspaces', {
    data: { name, locationRoot: 'temporary', directoryName: name, ...extra },
  });
  expect(res.status(), 'Expect the workspace to be created').toBe(201);
  const ws = await res.json();
  return ws.id as string;
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('toggling Auto on via the add menu shows the chip next to the model chip', async ({
      page,
      request,
    }, testInfo) => {
      const wsId = await createWorkspace(request, `auto-approve-toggle-ws-${Date.now()}`);

      await page.goto(`/workspaces/${wsId}`);
      await page.getByRole('button', { name: 'Chat' }).click();

      await expect(page.getByTestId('auto-approve-chip')).toHaveCount(0);

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Add to message' }).click();
      await page.getByTestId('auto-approve-menu-item').click();

      await expect(page.getByTestId('auto-approve-chip')).toBeVisible();

      // Real round trip, not mocked — the whole point of this test is that
      // the toggle persists via the real PATCH endpoint.
      const ws = await (await request.get(`/api/v1/workspaces/${wsId}`)).json();
      expect(ws.autoApproveShell).toBe(true);
    });

    test('no approval card renders for a completed shell_exec call while Auto is on', async ({
      page,
      request,
    }, testInfo) => {
      const wsId = await createWorkspace(request, `auto-approve-no-prompt-ws-${Date.now()}`, {
        autoApproveShell: true,
      });

      // No pending hitl_prompt message — what the thread looks like after an
      // auto-approved shell_exec call, which (unlike a requires-approval
      // call that waits on a user) never produces one. The exact shape of
      // the completed tool call itself isn't needed for this assertion;
      // only that no approval prompt exists.
      await page.route(`**/api/v1/workspaces/${wsId}/chat/**`, async (route: Route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }
        await route.fulfill({ json: { messages: [], summaryPath: null, summarizedAt: null } });
      });

      await pauseBeforeAction(page, testInfo);
      await page.goto(`/workspaces/${wsId}`);
      await page.getByRole('button', { name: 'Chat' }).click();

      await expect(page.getByTestId('auto-approve-chip')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
      await expect(page.locator('[data-slot="textarea"]')).toBeEnabled();
    });

    test('clicking the chip turns Auto off, and a pending shell_approval prompt renders normally', async ({
      page,
      request,
    }, testInfo) => {
      const wsId = await createWorkspace(request, `auto-approve-toggle-off-ws-${Date.now()}`, {
        autoApproveShell: true,
      });

      const pendingPrompt = {
        kind: 'hitl_prompt',
        id: 'prompt-1',
        seq: 2,
        status: 'pending',
        promptId: 'prompt-1',
        question: 'Approve command execution?',
        promptKind: 'shell_approval',
        command: 'npm install',
        reason: 'Install dependencies',
      };

      await page.route(`**/api/v1/workspaces/${wsId}/chat/**`, async (route: Route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }
        await route.fulfill({
          json: { messages: [pendingPrompt], summaryPath: null, summarizedAt: null },
        });
      });

      await page.goto(`/workspaces/${wsId}`);
      await page.getByRole('button', { name: 'Chat' }).click();
      await expect(page.getByTestId('auto-approve-chip')).toBeVisible();

      await pauseBeforeAction(page, testInfo);
      await page.getByTestId('auto-approve-chip').click();

      await expect(page.getByTestId('auto-approve-chip')).toHaveCount(0);
      const ws = await (await request.get(`/api/v1/workspaces/${wsId}`)).json();
      expect(ws.autoApproveShell).toBe(false);

      // The pending prompt itself is unaffected by the toggle (it was raised
      // before the toggle, same as a live interrupt would be — see the
      // design doc's "Toggling during an active waiting_on_user pause" note)
      // — this just confirms the approval UI still renders when a thread
      // does carry one, same as hitl-shell-approval.spec.ts covers in depth.
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    });
  },
);
