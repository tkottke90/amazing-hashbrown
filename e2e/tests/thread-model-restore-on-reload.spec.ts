import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 22,
  name: 'Thread Model Restore On Reload',
  description:
    'Verifies that reloading a chat thread restores its persisted provider/model instead of showing the global default',
  purpose:
    'Regression coverage for issue #195 — hydrate() previously discarded the provider/model already present in its own response, and an unrelated providers fetch usually won the race to set the chip first',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action:
        'Load a thread whose persisted model differs from the global default, with the providers response resolving before the thread-detail response (the ordering that caused the original bug)',
      expectedOutcome: "The model chip shows the thread's persisted model, not the default",
      test: () => {},
    },
  ],
};

const THREAD_ID = 'thread-model-restore-test';

const MOCK_PROVIDERS = {
  providers: [
    {
      name: 'openai',
      type: 'openai',
      defaultModel: 'gpt-4o',
      models: [{ id: 'gpt-4o' }],
    },
    {
      name: 'ollama',
      type: 'ollama',
      models: [{ id: 'llama3.2' }],
    },
  ],
  defaultProvider: 'openai',
};

const mockThread = {
  id: THREAD_ID,
  title: 'Model Restore Test',
  createdAt: '2026-08-06T10:00:00.000Z',
  updatedAt: '2026-08-06T10:01:00.000Z',
  forkedFromThreadId: null,
  forkedFromSeq: null,
  afterAgentState: { status: 'idle' },
  links: {
    self: `/api/v1/threads/${THREAD_ID}`,
    afterAgentStatus: `/api/v1/threads/${THREAD_ID}/after-agent-status`,
  },
  provider: 'ollama',
  model: 'llama3.2',
};

async function mockApis(page: import('@playwright/test').Page) {
  // Resolves immediately — this is the fetch that used to win the race and
  // stamp the default into the model chip before hydrate() ever applied the
  // thread's persisted model.
  await page.route('**/api/v1/providers', async (route: Route) => {
    await route.fulfill({ json: MOCK_PROVIDERS });
  });

  await page.route('**/api/v1/threads**', async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const match = url.pathname.match(/^\/api\/v1\/threads(?:\/([^/]+))?$/);

    if (!match) {
      await route.fallback();
      return;
    }

    const id = match[1];

    if (!id && method === 'GET') {
      await route.fulfill({ json: [mockThread] });
      return;
    }

    if (id === THREAD_ID && method === 'GET') {
      // Deliberately slower than the providers response above — forces the
      // exact ordering that caused the original bug (default applied before
      // the persisted model was known).
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ json: { ...mockThread, messages: [] } });
      return;
    }

    await route.fallback();
  });
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('reloading a thread shows its persisted model, not the global default', async ({
      page,
    }, testInfo) => {
      await mockApis(page);
      await page.goto(`/chat/${THREAD_ID}`);
      await pauseBeforeAction(page, testInfo);

      // toHaveText auto-retries, so this is the meaningful regression guard:
      // on the buggy code the chip permanently shows the default (it never
      // self-corrects once the providers fetch has won), so this assertion
      // fails against the bug and passes once hydrate() applies the
      // persisted model.
      await expect(page.locator('[data-slot="model-chip"]')).toHaveText(mockThread.model);
    });
  },
);
