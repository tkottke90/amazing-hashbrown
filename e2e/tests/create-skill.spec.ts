import { test, expect, type Route, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 28,
  name: 'Create-Skill Guided Flow',
  description:
    "Verifies the /create-skill chat skill's HITL rendering (the multiple_choice scope question it asks, " +
    'not exercised by any other HITL spec) and that a skill it produces shows up correctly in the Skill Manager',
  purpose:
    'Catch regressions in the multiple_choice HITL rendering path the create-skill flow introduces, and confirm ' +
    'its eventual output (a skill) renders correctly in the existing Skill Manager UI — without needing a live LLM ' +
    'to drive the full multi-turn interview',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action:
        'Load a thread whose last message is a pending multiple_choice HITL prompt (the scope question)',
      expectedOutcome:
        'Both scope choices render as clickable buttons; no free-text input is shown',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click a scope choice',
      expectedOutcome: 'The HITL answer is submitted and the chat input re-enables',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open the Skill Manager after a skill has been created via /create-skill',
      expectedOutcome:
        'The new skill appears in the list with its name, description, and Edit/Enabled buttons',
      test: () => {},
    },
  ],
};

const THREAD_ID = 'thread-create-skill-test';

const mockThread = {
  id: THREAD_ID,
  title: 'Create Skill Test',
  createdAt: '2026-10-16T10:00:00.000Z',
  updatedAt: '2026-10-16T10:01:00.000Z',
  forkedFromThreadId: null,
  forkedFromSeq: null,
  afterAgentState: { status: 'idle' },
  links: {
    self: `/api/v1/threads/${THREAD_ID}`,
    afterAgentStatus: `/api/v1/threads/${THREAD_ID}/after-agent-status`,
  },
};

// The scope question from create-skill's step 1 — a multiple_choice prompt,
// not covered by any other HITL e2e spec today (those exercise
// shell_approval/yes_no/free_text — see e2e/AGENTS.md's data-testid table).
const pendingScopePrompt = {
  id: 'prompt-scope-1',
  kind: 'hitl_prompt',
  seq: 2,
  status: 'pending',
  promptId: 'prompt-scope-1',
  question: 'Create this skill app-wide, or just for this workspace?',
  promptKind: 'multiple_choice',
  choices: [
    'App-wide - visible in the Skill Manager and every chat',
    'This workspace - visible only here, under .agents/skills',
  ],
};

async function mockApis(page: Page) {
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
      await route.fulfill({ json: { ...mockThread, messages: [pendingScopePrompt] } });
      return;
    }

    await route.fallback();
  });

  await page.route(`**/api/v1/chat/${THREAD_ID}/hitl`, async (route: Route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: 'data: {"type":"stream_done","durationMs":50}\n\n',
      });
      return;
    }
    await route.fallback();
  });
}

interface FakeSkill {
  name: string;
  slashCommand: string;
  enabled: boolean;
  frontmatter: { name: string; description: string };
}

// Scoped to just what this spec needs (a listing GET) rather than the full
// CRUD fixture settings-skills-panel.spec.ts builds for its own, much wider
// set of cases — that file's mockSkillsApi/makeSkill helpers aren't exported,
// and this spec only needs to prove create-skill's eventual output (a skill
// record) renders correctly, not re-exercise the Skill Manager's full CRUD
// surface (already covered there).
async function mockSkillsListing(page: Page, skills: FakeSkill[]) {
  await page.route('**/api/v1/skills**', async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        skills: skills.map((s) => ({
          name: s.name,
          description: s.frontmatter.description,
          slashCommand: s.slashCommand,
          enabled: s.enabled,
          largeDesc: false,
        })),
      },
    });
  });
}

function skillRow(page: Page, name: string) {
  return page.locator('[data-slot="skill-row"]', { hasText: name });
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('pending multiple_choice scope question renders both choices as buttons, not a text input', async ({
      page,
    }, testInfo) => {
      await mockApis(page);
      await page.goto('/');

      const row = page.locator('[data-slot="thread-row"]').filter({ hasText: 'Create Skill Test' });
      await pauseBeforeAction(page, testInfo);
      await row.click();

      await expect(page.locator('[data-slot="textarea"]')).toBeDisabled({ timeout: 10_000 });

      await expect(page.getByRole('button', { name: /App-wide/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /This workspace/ })).toBeVisible();
      await expect(page.locator('input[placeholder="Type your answer…"]')).not.toBeVisible();
    });

    test('clicking a scope choice submits the answer and re-enables the chat input', async ({
      page,
    }, testInfo) => {
      await mockApis(page);
      await page.goto('/');

      const row = page.locator('[data-slot="thread-row"]').filter({ hasText: 'Create Skill Test' });
      await row.click();

      await expect(page.locator('[data-slot="textarea"]')).toBeDisabled({ timeout: 10_000 });

      const hitlRequest = page.waitForRequest(
        (req) => req.url().includes(`/api/v1/chat/${THREAD_ID}/hitl`) && req.method() === 'POST',
      );
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: /App-wide/ }).click();
      const request = await hitlRequest;
      expect((request.postDataJSON() as { answer?: string }).answer).toContain('App-wide');

      await expect(page.locator('[data-slot="textarea"]')).toBeEnabled({ timeout: 10_000 });
    });

    test('a skill created via /create-skill shows up correctly in the Skill Manager', async ({
      page,
    }, testInfo) => {
      await mockSkillsListing(page, [
        {
          name: 'wiki-search-tips',
          slashCommand: '/wiki-search-tips',
          enabled: true,
          frontmatter: {
            name: 'wiki-search-tips',
            description: 'Tips for searching the wiki — trigger on "how do I search the wiki".',
          },
        },
      ]);
      await page.goto('/settings?section=skills');
      await pauseBeforeAction(page, testInfo);

      const row = skillRow(page, 'wiki-search-tips');
      await expect(row).toBeVisible();
      await expect(row).toContainText('Tips for searching the wiki');
      await expect(row.getByRole('button', { name: 'Edit' })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Enabled' })).toBeVisible();
    });
  },
);
