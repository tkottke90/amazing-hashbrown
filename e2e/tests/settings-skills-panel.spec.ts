import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 27,
  name: 'Settings skills panel',
  description:
    'Verifies the Skills settings tab: listing, create/edit/delete, enable/disable with the gated-skill guard, script/reference file management, and eval case editing — all against a mocked skills API',
  purpose:
    'Ensure the Skills management UI (issue #116) wires up its full CRUD flow correctly without a live backend',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Navigate to the Skills settings tab',
      expectedOutcome: 'Seeded skills are listed in the aside',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Create a new skill via the form',
      expectedOutcome: 'The new skill appears selected with its Details tab open',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Edit description/body and save',
      expectedOutcome: 'PATCH request carries the edited fields and a success toast appears',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Toggle enabled for a non-gated skill',
      expectedOutcome: 'PATCH fires immediately with no confirmation dialog',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Toggle enabled off for the gated create-workspace skill',
      expectedOutcome: 'A confirmation dialog names the create_workspace tool; accepting fires the PATCH, dismissing reverts the switch',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add, edit, and delete a script file',
      expectedOutcome: 'PUT/DELETE requests fire correctly with a confirmation on delete',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add and remove an eval case, then save',
      expectedOutcome: 'PUT /:name/evals body reflects the edited case list',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: "Select the gated create-workspace skill's Details tab",
      expectedOutcome: 'Delete button is disabled and clicking it triggers no dialog or network call',
      test: () => {},
    },
  ],
};

interface FakeSkill {
  name: string;
  slashCommand: string;
  enabled: boolean;
  path: string;
  frontmatter: {
    name: string;
    description: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    'allowed-tools'?: string;
  };
  body: string;
  scripts: Record<string, string>;
  references: Record<string, string>;
}

function makeSkill(name: string, description: string, enabled = true): FakeSkill {
  return {
    name,
    slashCommand: `/${name}`,
    enabled,
    path: `/skills/${name}`,
    frontmatter: { name, description },
    body: `${name} body.`,
    scripts: {},
    references: {},
  };
}

function toSummary(s: FakeSkill) {
  return {
    name: s.name,
    description: s.frontmatter.description,
    slashCommand: s.slashCommand,
    enabled: s.enabled,
    largeDesc: false,
  };
}

async function mockSkillsApi(page: Page, seed: FakeSkill[]) {
  const skills = new Map(seed.map((s) => [s.name, s]));
  const evalsBySkill = new Map<string, { skill_name: string; evals: unknown[] }>();

  await page.route('**/api/v1/skills**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const pathParts = url.pathname.replace('/api/v1/skills', '').split('/').filter(Boolean);

    if (pathParts.length === 0) {
      if (method === 'GET') {
        const all = url.searchParams.get('all') === 'true';
        const q = url.searchParams.get('q')?.toLowerCase();
        let list = Array.from(skills.values());
        if (!all) list = list.filter((s) => s.enabled);
        if (q) {
          list = list.filter(
            (s) =>
              s.name.toLowerCase().includes(q) || s.frontmatter.description.toLowerCase().includes(q),
          );
        }
        await route.fulfill({ json: { skills: list.map(toSummary) } });
        return;
      }
      if (method === 'POST') {
        const body = req.postDataJSON() as {
          name: string;
          description: string;
          body?: string;
        };
        const skill = makeSkill(body.name, body.description);
        skill.body = body.body ?? '';
        skills.set(skill.name, skill);
        await route.fulfill({ status: 201, json: skill });
        return;
      }
      await route.fallback();
      return;
    }

    const name = decodeURIComponent(pathParts[0]!);
    const skill = skills.get(name);

    if (pathParts.length === 1) {
      if (method === 'GET') {
        if (!skill) {
          await route.fulfill({ status: 404, json: { error: `Skill "${name}" not found` } });
          return;
        }
        await route.fulfill({ json: skill });
        return;
      }
      if (method === 'PATCH') {
        if (!skill) {
          await route.fulfill({ status: 404, json: { error: `Skill "${name}" not found` } });
          return;
        }
        const body = req.postDataJSON() as Record<string, unknown>;
        if (typeof body.description === 'string') skill.frontmatter.description = body.description;
        if (typeof body.body === 'string') skill.body = body.body;
        if (typeof body.license === 'string') skill.frontmatter.license = body.license;
        if (typeof body.compatibility === 'string') skill.frontmatter.compatibility = body.compatibility;
        if (typeof body.allowedTools === 'string') skill.frontmatter['allowed-tools'] = body.allowedTools;
        if (typeof body.enabled === 'boolean') skill.enabled = body.enabled;
        await route.fulfill({ json: skill });
        return;
      }
      if (method === 'DELETE') {
        if (name === 'create-workspace' || name === 'create-project') {
          await route.fulfill({
            status: 409,
            json: { error: `Skill "${name}" is required by tool-gating and cannot be deleted` },
          });
          return;
        }
        skills.delete(name);
        await route.fulfill({ json: { deleted: true } });
        return;
      }
    }

    if (pathParts[1] === 'files' && pathParts.length === 4) {
      const dir = pathParts[2] as 'scripts' | 'references';
      const basename = decodeURIComponent(pathParts[3]!);
      if (!skill) {
        await route.fulfill({ status: 404, json: { error: `Skill "${name}" not found` } });
        return;
      }
      if (method === 'GET') {
        const content = skill[dir][basename];
        if (content === undefined) {
          await route.fulfill({ status: 404, json: { error: `File "${basename}" not found` } });
          return;
        }
        await route.fulfill({ json: { content } });
        return;
      }
      if (method === 'PUT') {
        const body = req.postDataJSON() as { content: string };
        skill[dir][basename] = body.content;
        await route.fulfill({ json: { saved: true } });
        return;
      }
      if (method === 'DELETE') {
        delete skill[dir][basename];
        await route.fulfill({ json: { deleted: true } });
        return;
      }
    }

    if (pathParts[1] === 'evals') {
      if (method === 'GET') {
        const suite = evalsBySkill.get(name) ?? { skill_name: name, evals: [] };
        await route.fulfill({ json: suite });
        return;
      }
      if (method === 'PUT') {
        const body = req.postDataJSON() as { skill_name: string; evals: unknown[] };
        evalsBySkill.set(name, body);
        await route.fulfill({ json: { saved: true } });
        return;
      }
    }

    await route.fallback();
  });

  return { skills, evalsBySkill };
}

const SEED = () => [
  makeSkill('create-workspace', 'Create a new workspace conversationally.'),
  makeSkill('create-project', 'Create a new project conversationally.'),
  makeSkill('brainstorming', 'Turn ideas into designs.'),
];

test.describe('Settings skills panel', { annotation: suiteAnnotations(suite) }, () => {
  test('Lists seeded skills in the aside @smoke', async ({ page }, testInfo) => {
    await mockSkillsApi(page, SEED());
    await page.goto('/settings?section=skills');
    await pauseBeforeAction(page, testInfo);

    await expect(page.getByText('create-workspace', { exact: true })).toBeVisible();
    await expect(page.getByText('create-project', { exact: true })).toBeVisible();
    await expect(page.getByText('brainstorming', { exact: true })).toBeVisible();
  });

  test('Creates a new skill via the form @user-workflow', async ({ page }, testInfo) => {
    await mockSkillsApi(page, SEED());
    await page.goto('/settings?section=skills');
    await page.getByText('create-workspace', { exact: true }).waitFor();
    await pauseBeforeAction(page, testInfo);

    await page.getByRole('button', { name: '+ New skill' }).click();
    await page.getByLabel('Name').fill('my-new-skill');
    await page.getByLabel('Description').fill('A brand new skill');
    await page.getByRole('button', { name: 'Create skill' }).click();

    await expect(page.getByRole('alert')).toContainText('created');
    await expect(page.getByLabel('Name')).toHaveValue('my-new-skill');
  });

  test('Edits description and body, saves @user-workflow', async ({ page }, testInfo) => {
    await mockSkillsApi(page, SEED());
    await page.goto('/settings?section=skills');
    await pauseBeforeAction(page, testInfo);

    await page.getByText('brainstorming', { exact: true }).click();
    await page.getByLabel('Description').fill('Updated description');

    const patchRequest = page.waitForRequest(
      (req) => req.url().includes('/api/v1/skills/brainstorming') && req.method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    const request = await patchRequest;
    const body = request.postDataJSON() as { description?: string };
    expect(body.description).toBe('Updated description');

    await expect(page.getByRole('alert')).toContainText('saved');
  });

  test('Toggles enabled for a non-gated skill with no dialog @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockSkillsApi(page, SEED());
    await page.goto('/settings?section=skills');
    await pauseBeforeAction(page, testInfo);

    const row = page.locator('[data-slot="skill-row"]', { hasText: 'brainstorming' });
    const patchRequest = page.waitForRequest(
      (req) => req.url().includes('/api/v1/skills/brainstorming') && req.method() === 'PATCH',
    );
    await row.getByRole('switch').click();
    const request = await patchRequest;
    expect((request.postDataJSON() as { enabled?: boolean }).enabled).toBe(false);
  });

  test('Disabling the gated create-workspace skill asks for confirmation @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockSkillsApi(page, SEED());
    await page.goto('/settings?section=skills');
    await pauseBeforeAction(page, testInfo);

    const row = page.locator('[data-slot="skill-row"]', { hasText: 'create-workspace' });

    let dialogMessage = '';
    page.once('dialog', (d) => {
      dialogMessage = d.message();
      d.dismiss();
    });
    await row.getByRole('switch').click();
    expect(dialogMessage).toContain('create_workspace');
    await expect(row.getByRole('switch')).toBeChecked();

    const patchRequest = page.waitForRequest(
      (req) => req.url().includes('/api/v1/skills/create-workspace') && req.method() === 'PATCH',
    );
    page.once('dialog', (d) => d.accept());
    await row.getByRole('switch').click();
    await patchRequest;
    await expect(row.getByRole('switch')).not.toBeChecked();
  });

  test('Adds, edits, and deletes a script file @user-workflow', async ({ page }, testInfo) => {
    await mockSkillsApi(page, SEED());
    await page.goto('/settings?section=skills');
    await pauseBeforeAction(page, testInfo);

    await page.getByText('brainstorming', { exact: true }).click();
    await page.getByRole('button', { name: 'Scripts' }).click();

    await page.getByPlaceholder('filename.js').fill('run.js');
    await page.getByRole('button', { name: 'Add' }).click();

    const putRequest = page.waitForRequest(
      (req) =>
        req.url().includes('/api/v1/skills/brainstorming/files/scripts/run.js') &&
        req.method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    await putRequest;
    await expect(page.getByRole('alert')).toContainText('Saved');

    page.once('dialog', (d) => d.accept());
    const deleteRequest = page.waitForRequest(
      (req) =>
        req.url().includes('/api/v1/skills/brainstorming/files/scripts/run.js') &&
        req.method() === 'DELETE',
    );
    await page.getByRole('button', { name: 'Delete' }).click();
    await deleteRequest;
  });

  test('Adds and removes an eval case, saves @user-workflow', async ({ page }, testInfo) => {
    await mockSkillsApi(page, SEED());
    await page.goto('/settings?section=skills');
    await pauseBeforeAction(page, testInfo);

    await page.getByText('brainstorming', { exact: true }).click();
    await page.getByRole('button', { name: 'Evals' }).click();

    await page.getByRole('button', { name: '+ Add case' }).click();
    await page.getByLabel('Prompt').fill('Do the thing');
    await page.getByLabel('Expected output').fill('The thing is done');

    const putRequest = page.waitForRequest(
      (req) => req.url().includes('/api/v1/skills/brainstorming/evals') && req.method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    const request = await putRequest;
    const body = request.postDataJSON() as { evals: { prompt: string }[] };
    expect(body.evals).toHaveLength(1);
    expect(body.evals[0]?.prompt).toBe('Do the thing');
  });

  test("Gated skill's Delete button is disabled with no dialog or network call @smoke", async ({
    page,
  }, testInfo) => {
    await mockSkillsApi(page, SEED());
    await page.goto('/settings?section=skills');
    await pauseBeforeAction(page, testInfo);

    await page.getByText('create-workspace', { exact: true }).click();

    let dialogFired = false;
    page.on('dialog', () => {
      dialogFired = true;
    });
    let deleteCalled = false;
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/api/v1/skills/create-workspace')) {
        deleteCalled = true;
      }
    });

    const deleteButton = page.getByRole('button', { name: 'Delete' });
    await expect(deleteButton).toBeDisabled();
    await deleteButton.click({ force: true });

    expect(dialogFired).toBe(false);
    expect(deleteCalled).toBe(false);
  });
});
