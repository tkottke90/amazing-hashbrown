import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 45,
  name: 'Kanban board — lanes and drag-and-drop',
  description:
    'Verifies the five-lane Tasks board: cards land in the lane the server assigns, and dragging a card (mouse or keyboard) between lanes performs the matching task action',
  purpose:
    'Drag-and-drop is the fastest way to change what a task is doing; a wrong drop mapping would silently enqueue, unschedule or finish the wrong work',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Seed tasks in several states and open the Tasks tab',
      expectedOutcome: 'Five lanes render with the right card counts',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Drag a Backlog card onto Queue',
      expectedOutcome: 'The task is queued for the agent and its card moves to Queue',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Drag a queued card above another queued card',
      expectedOutcome: 'The queue order changes on the server and on the board',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Drag a Backlog card onto Scheduled, pick a time, confirm',
      expectedOutcome: 'The task gets a one-off schedule and sits in Scheduled',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Drag a repeating task from Scheduled onto Backlog',
      expectedOutcome: 'Its schedule is turned off and the card moves to Backlog',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Drag a running card onto Done',
      expectedOutcome: 'Done is marked as not allowed and the drop changes nothing',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action:
        'Pick a card up with Space, move it right two lanes with the arrow key, drop it with Space',
      expectedOutcome: 'The card passes over Scheduled and lands in Queue, queued for the agent',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Drag a card while the server rejects the move',
      expectedOutcome: "The card snaps back and the server's reason is shown",
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Move a task with the drawer\'s "Move to" picker',
      expectedOutcome: 'The task moves without dragging',
      test: () => {},
    },
  ],
};

// Unique per run, so a local rerun against the same data never collides
// with a workspace (or its temp directory) from the previous run.
async function createWorkspace(request: APIRequestContext, name: string) {
  const slug = `${name}-${Date.now()}`;
  const res = await request.post('/api/v1/workspaces', {
    data: { name: slug, locationRoot: 'temporary', directoryName: slug },
  });
  expect(res.status(), 'workspace created').toBe(201);
  return (await res.json()) as { id: string };
}

async function createTask(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post('/api/v1/tasks', { data });
  expect(res.status(), 'task created').toBe(201);
  return (await res.json()) as { id: string; status: string };
}

async function getTask(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/v1/tasks/${id}`)).json()) as {
    status: string;
    triggerType: string;
    triggerConfig: { enabled?: boolean } | null;
  };
}

async function openTasksTab(page: Page, workspaceId: string) {
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole('button', { name: /tasks/i }).click();
  await expect(page.getByTestId('task-board')).toBeVisible();
}

const lane = (page: Page, id: string) => page.locator(`[data-column="${id}"]`);
const card = (scope: Page | Locator, title: string) =>
  scope.locator('[data-testid="task-card"]').filter({ hasText: title });

// A real pointer drag: dnd-kit only starts dragging after the pointer has
// moved a few pixels, then tracks the pointer to the drop target.
async function drag(page: Page, source: Locator, target: Locator) {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 60), { steps: 12 });
  await page.mouse.up();
}

test.describe(
  '@smoke',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('shows five lanes with each task in the lane the server assigned', async ({
      page,
      request,
    }) => {
      const ws = await createWorkspace(request, 'board-smoke');
      await createTask(request, { title: 'Smoke backlog', workspaceId: ws.id });
      const done = await createTask(request, { title: 'Smoke done', workspaceId: ws.id });
      await request.patch(`/api/v1/tasks/${done.id}`, { data: { status: 'done' } });
      const failed = await createTask(request, { title: 'Smoke failed', workspaceId: ws.id });
      await request.patch(`/api/v1/tasks/${failed.id}`, { data: { status: 'failed' } });

      await openTasksTab(page, ws.id);

      const lanes = page.locator('[data-column]');
      await expect(lanes).toHaveCount(5);
      await expect(lanes.nth(0)).toHaveAttribute('data-column', 'backlog');
      await expect(lanes.nth(4)).toHaveAttribute('data-column', 'done');
      await expect(lane(page, 'backlog').getByTestId('lane-count')).toHaveText('1');
      await expect(lane(page, 'attention').getByTestId('lane-count')).toHaveText('1');
      await expect(lane(page, 'done').getByTestId('lane-count')).toHaveText('1');
      await expect(card(lane(page, 'attention'), 'Smoke failed')).toHaveAttribute(
        'data-status',
        'failed',
      );
    });
  },
);

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('dragging a Backlog card onto Queue queues it for the agent', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'board-enqueue');
      const task = await createTask(request, {
        title: 'Drag me to the queue',
        workspaceId: ws.id,
        assignedTo: 'agent',
      });
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await drag(page, card(page, 'Drag me to the queue'), lane(page, 'queue'));

      await expect(card(lane(page, 'queue'), 'Drag me to the queue')).toBeVisible();
      // The e2e server's no-op executor starts the task and never finishes it.
      await expect
        .poll(async () => (await getTask(request, task.id)).status)
        .toMatch(/^(ready|running)$/);
    });

    test('dragging a queued card above another reorders the queue', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'board-reorder');
      for (const title of ['Runs first', 'Queued A', 'Queued B']) {
        const t = await createTask(request, { title, workspaceId: ws.id, assignedTo: 'agent' });
        await request.post(`/api/v1/tasks/${t.id}/move`, { data: { to: 'queue' } });
      }
      await openTasksTab(page, ws.id);
      const queue = lane(page, 'queue');
      await expect(queue.getByTestId('task-card')).toHaveCount(3);

      await pauseBeforeAction(page, testInfo);
      await drag(page, card(queue, 'Queued B'), card(queue, 'Queued A'));

      await expect
        .poll(async () => {
          const state = (await (await request.get('/api/v1/tasks/queue')).json()) as {
            queue: Array<{ status: string; task: { title: string; workspaceId: string } | null }>;
          };
          // The queue is global; other tests' workspaces may share it.
          return state.queue
            .filter((e) => e.status === 'pending' && e.task?.workspaceId === ws.id)
            .map((e) => e.task?.title);
        })
        .toEqual(['Queued B', 'Queued A']);
      await expect(queue.getByTestId('task-card')).toContainText([
        'Runs first',
        'Queued B',
        'Queued A',
      ]);
    });

    test('dropping on Scheduled asks for a start time and schedules the task', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'board-schedule');
      const task = await createTask(request, { title: 'Schedule me', workspaceId: ws.id });
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await drag(page, card(page, 'Schedule me'), lane(page, 'scheduled'));

      const picker = page.getByTestId('move-start-time-form');
      await expect(picker).toBeVisible();
      await page.getByTestId('cron-once-fire-at').fill('2030-01-15T09:30');
      await pauseBeforeAction(page, testInfo);
      await picker.getByRole('button', { name: 'Schedule' }).click();

      const scheduled = card(lane(page, 'scheduled'), 'Schedule me');
      await expect(scheduled).toHaveAttribute('data-status', 'scheduled');
      await expect(scheduled.getByTestId('task-card-schedule')).toContainText('next:');
      expect((await getTask(request, task.id)).triggerType).toBe('cron_once');
    });

    test('dragging a repeating task out of Scheduled turns its schedule off', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'board-unschedule');
      const task = await createTask(request, {
        title: 'Nightly report',
        workspaceId: ws.id,
        triggerType: 'cron_repeat',
        triggerConfig: { expression: '0 2 * * *', timezone: 'UTC' },
      });
      expect(task.status).toBe('scheduled');
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await drag(page, card(lane(page, 'scheduled'), 'Nightly report'), lane(page, 'backlog'));

      await expect(card(lane(page, 'backlog'), 'Nightly report')).toHaveAttribute(
        'data-status',
        'pending',
      );
      const saved = await getTask(request, task.id);
      expect(saved.status).toBe('pending');
      expect(saved.triggerConfig?.enabled, 'the schedule must not fire any more').toBe(false);
    });

    test('a running card cannot be dropped on Done', async ({ page, request }, testInfo) => {
      const ws = await createWorkspace(request, 'board-illegal');
      const task = await createTask(request, {
        title: 'Busy task',
        workspaceId: ws.id,
        assignedTo: 'agent',
      });
      await request.post(`/api/v1/tasks/${task.id}/move`, { data: { to: 'queue' } });
      await expect.poll(async () => (await getTask(request, task.id)).status).toBe('running');
      await openTasksTab(page, ws.id);
      const running = card(lane(page, 'queue'), 'Busy task');
      await expect(running).toHaveAttribute('data-status', 'running');

      // Hold the card over Done to see the lane refuse it, then drop.
      await pauseBeforeAction(page, testInfo);
      const from = (await running.boundingBox())!;
      const to = (await lane(page, 'done').boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
      await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 12 });
      await expect(lane(page, 'done')).toHaveAttribute('data-drop-state', 'blocked');
      await page.mouse.up();

      await expect(card(lane(page, 'queue'), 'Busy task')).toBeVisible();
      expect((await getTask(request, task.id)).status).toBe('running');
    });

    test('a card can be moved with the keyboard', async ({ page, request }, testInfo) => {
      const ws = await createWorkspace(request, 'board-keyboard');
      const task = await createTask(request, {
        title: 'Keyboard task',
        workspaceId: ws.id,
        assignedTo: 'agent',
      });
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await card(page, 'Keyboard task').focus();
      await page.keyboard.press('Space'); // pick up
      await expect(lane(page, 'done')).toHaveAttribute('data-drop-state', 'allowed');
      // dnd-kit's keyboard sensor starts listening for arrow keys in a
      // setTimeout queued while handling Space; one page-side timer turn
      // (timers run in order) guarantees it's listening — no fixed sleep.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
      await page.keyboard.press('ArrowRight');
      await expect(lane(page, 'scheduled')).toHaveAttribute('data-over', 'true');
      await page.keyboard.press('ArrowRight');
      await expect(lane(page, 'queue')).toHaveAttribute('data-over', 'true');
      await page.keyboard.press('Space'); // drop

      await expect(card(lane(page, 'queue'), 'Keyboard task')).toBeVisible();
      await expect
        .poll(async () => (await getTask(request, task.id)).status)
        .toMatch(/^(ready|running)$/);
    });

    test("a rejected move snaps back and shows the server's reason", async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'board-rejected');
      await createTask(request, {
        title: 'Rejected move',
        workspaceId: ws.id,
        assignedTo: 'agent',
      });
      // Simulates a stale board: the server has since decided this move is
      // no longer legal. Only the move itself is mocked.
      await page.route('**/api/v1/tasks/*/move', (route) =>
        route.fulfill({ status: 409, json: { error: 'The task is no longer queued.' } }),
      );
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await drag(page, card(page, 'Rejected move'), lane(page, 'queue'));

      await expect(page.getByRole('alert').filter({ hasText: 'no longer queued' })).toBeVisible();
      await expect(card(lane(page, 'backlog'), 'Rejected move')).toBeVisible();
    });

    test('the drawer\'s "Move to" picker moves a task without dragging', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'board-move-to');
      const task = await createTask(request, { title: 'Picker task', workspaceId: ws.id });
      await openTasksTab(page, ws.id);

      await card(page, 'Picker task').click();
      const drawer = page.locator('dialog[open]');
      await pauseBeforeAction(page, testInfo);
      await drawer.getByTestId('board-move-to').selectOption('done');

      await expect(card(lane(page, 'done'), 'Picker task')).toBeVisible();
      expect((await getTask(request, task.id)).status).toBe('done');
    });
  },
);
