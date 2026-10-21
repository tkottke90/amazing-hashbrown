import { test, expect, type APIRequestContext, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 58,
  name: 'Workspace Retrospective Report',
  description:
    'Verifies the Generate retrospective report button opens an HTML report in a new browser tab, for both the desktop workspace header and the mobile Actions sheet',
  purpose:
    'Ensure the retrospective report button wires up to the workspace-level API endpoint and the response is displayed in a new tab without requiring a live database',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Open a workspace on desktop and click "Generate retrospective report" in the header',
      expectedOutcome: 'A new tab opens and displays the mocked HTML report content',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open a workspace on a phone viewport, open Actions, and tap Generate',
      expectedOutcome: 'A new tab opens and displays the mocked HTML report content',
      test: () => {},
    },
  ],
};

const REPORT_HTML = `<!DOCTYPE html><html><body><h1>Workspace Retrospective</h1></body></html>`;

const createdWorkspaceIds: string[] = [];

async function createWorkspace(request: APIRequestContext, name: string) {
  const slug = `${name}-${Date.now()}`;
  const res = await request.post('/api/v1/workspaces', {
    data: { name: slug, locationRoot: 'temporary', directoryName: slug },
  });
  expect(res.status(), 'workspace created').toBe(201);
  const ws = (await res.json()) as { id: string };
  createdWorkspaceIds.push(ws.id);
  return ws;
}

test.afterEach(async ({ request }) => {
  for (const id of createdWorkspaceIds.splice(0)) {
    await request.delete(`/api/v1/workspaces/${id}`);
  }
});

// Registered on context (not page) so the popup page's navigation is intercepted.
async function mockReportEndpoint(
  page: import('@playwright/test').Page,
  workspaceId: string,
): Promise<void> {
  await page
    .context()
    .route(`**/api/v1/workspaces/${workspaceId}/retrospective-report`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: REPORT_HTML,
      });
    });
}

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('desktop header: generate retrospective report opens HTML in a new tab', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'retro-desktop');
      await mockReportEndpoint(page, ws.id);
      await page.goto(`/workspaces/${ws.id}`);
      await pauseBeforeAction(page, testInfo);

      const newPagePromise = page.context().waitForEvent('page');
      await page.getByRole('button', { name: 'Generate retrospective report' }).click();
      const reportPage = await newPagePromise;

      await reportPage.waitForLoadState();
      await expect(reportPage.locator('h1')).toHaveText('Workspace Retrospective');
    });

    test.describe('mobile Actions sheet', () => {
      test.use({ viewport: { width: 390, height: 844 } });

      test('generate retrospective report opens HTML in a new tab', async ({
        page,
        request,
      }, testInfo) => {
        const ws = await createWorkspace(request, 'retro-mobile');
        await mockReportEndpoint(page, ws.id);
        await page.goto(`/workspaces/${ws.id}`);
        await pauseBeforeAction(page, testInfo);

        await page.getByRole('button', { name: 'Open actions' }).click();

        const newPagePromise = page.context().waitForEvent('page');
        await page.getByTestId('actions-retrospective-report').click();
        const reportPage = await newPagePromise;

        await reportPage.waitForLoadState();
        await expect(reportPage.locator('h1')).toHaveText('Workspace Retrospective');
      });
    });
  },
);
