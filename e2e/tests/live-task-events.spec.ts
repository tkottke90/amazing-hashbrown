import { test, expect, type Route, type APIRequestContext } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

// Regression coverage for the three live-broadcast gaps fixed on top of the
// standing SSE channel (GET /api/v1/events, opened once per tab by
// use-live-events.ts's connectLiveEvents(), wired in app.tsx):
//
//   1. handleEvent() now calls refreshTasks() on every task_queue_update, so
//      the "Tasks (N)" tab label updates live instead of only on reload.
//   2. A new task_started broadcast rehydrates an already-open thread so the
//      "Automated task started" marker appears live.
//   3. The hitl_prompt/task_completed rehydrate gate was switched from
//      activeThreadId.value === threadId (only ever true for the global
//      /chat page) to hasThreadInstance(threadId), which also covers a
//      workspace's Chat tab — the actual surface task execution runs on.
//
// Each test below mocks GET /api/v1/events with a static SSE body (per this
// package's "SSE endpoints are not a special case" convention) but *gates*
// when that body is sent behind an in-test promise, so the "before" UI state
// can be asserted first and the "after" state only appears once the test
// explicitly releases the frame — see deferredGate() below.
const suite: TestSuite = {
  id: 30,
  name: 'Live Task Events',
  description:
    'Verifies the standing SSE channel (GET /api/v1/events) drives live UI updates for the ' +
    'Tasks(N) count, the task_started chat banner, and the hitl_prompt chat banner — without ' +
    'requiring a page reload',
  purpose:
    'Defend the three live-broadcast fixes (refreshTasks() on task_queue_update, the new ' +
    'task_started event, and the hasThreadInstance() rehydrate gate replacing the ' +
    'activeThreadId-only gate that silently never covered a workspace Chat tab) against ' +
    'regression',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Load a workspace, then deliver a mocked task_queue_update SSE frame',
      expectedOutcome: 'The "Tasks (N)" tab label updates to the new count without a reload',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action:
        "Open a workspace's Chat tab, then deliver a mocked task_started SSE frame for its thread",
      expectedOutcome: 'The "Automated task started: <title>" marker appears live',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action:
        "Open a workspace's Chat tab, then deliver a mocked hitl_prompt SSE frame for its thread",
      expectedOutcome:
        'The "Automated task waiting on you" marker and the pending HITL prompt both appear live',
      test: () => {},
    },
  ],
};

async function createWorkspace(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/api/v1/workspaces', {
    data: { name, locationRoot: 'temporary', directoryName: name },
  });
  expect(res.status(), 'Expect the workspace to be created').toBe(201);
  const ws = await res.json();
  return ws.id as string;
}

// Registers a route that stays pending (never resolves the request) until
// `release()` is called — the mechanism this file uses to control exactly
// when the standing SSE channel's mocked frame reaches the page, so each
// test can assert the "before" state before triggering the "after" state.
// This is preferred over "two sequential page.route() registrations" (the
// other option AGENTS.md-adjacent guidance mentions) because the frame's
// payload here depends on a value (the workspace's server-generated
// threadId) that isn't known until after the page has already started
// running — a second static registration can't inject that value once
// routing has already begun, but a gate closed over a `let` can.
function deferredGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('Tasks(N) count updates live from a task_queue_update broadcast', async ({
      page,
      request,
    }, testInfo) => {
      const wsId = await createWorkspace(request, 'live-events-tasks-count-ws');

      const tasksBefore: unknown[] = [];
      const tasksAfter = [
        {
          id: 'live-task-1',
          workspaceId: wsId,
          title: 'First live task',
          description: null,
          outcome: null,
          status: 'pending',
          assignedTo: 'agent',
          dueAt: null,
          expiresAt: null,
          triggerType: 'manual',
          triggerConfig: null,
          trackerType: null,
          trackerId: null,
          plan: null,
          blockedReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'live-task-2',
          workspaceId: wsId,
          title: 'Second live task',
          description: null,
          outcome: null,
          status: 'pending',
          assignedTo: 'agent',
          dueAt: null,
          expiresAt: null,
          triggerType: 'manual',
          triggerConfig: null,
          trackerType: null,
          trackerId: null,
          plan: null,
          blockedReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      let sseDelivered = false;
      const eventsGate = deferredGate();

      // GET /api/v1/tasks (both the page's own workspace-filtered mount fetch
      // and refreshTasks()'s unfiltered call from handleEvent()/es.onopen)
      // — deliberately excludes /api/v1/tasks/queue and /api/v1/tasks/:id
      // so the sidebar's queue widget and any other task endpoint pass
      // through untouched.
      await page.route('**/api/v1/tasks**', async (route: Route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'GET' || url.pathname !== '/api/v1/tasks') {
          await route.fallback();
          return;
        }
        await route.fulfill({ json: sseDelivered ? tasksAfter : tasksBefore });
      });

      await page.route('**/api/v1/events', async (route: Route) => {
        await eventsGate.promise;
        sseDelivered = true;
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: `data: ${JSON.stringify({ type: 'task_queue_update', queue: [], running: [] })}\n\n`,
        });
      });

      await page.goto(`/workspaces/${wsId}`);

      await expect(page.getByRole('button', { name: 'Tasks (0)' })).toBeVisible();

      await pauseBeforeAction(page, testInfo);
      eventsGate.release();

      await expect(page.getByRole('button', { name: 'Tasks (2)' })).toBeVisible();
    });

    test('task_started broadcast shows the "Automated task started" banner live in the workspace Chat tab', async ({
      page,
      request,
    }, testInfo) => {
      const wsId = await createWorkspace(request, 'live-events-task-started-ws');

      const taskTitle = 'Automated live-started task';
      const messagesBefore: unknown[] = [];

      let capturedThreadId: string | null = null;
      let sseDelivered = false;
      const eventsGate = deferredGate();

      // Captures the client-generated threadId (WorkspaceChatTab assigns one
      // via randomUUID() the first time this workspace's Chat tab mounts)
      // without diverting the PATCH away from the real server — the
      // workspace really needs to end up with a threadId assigned, and
      // refreshWorkspaces() re-reads that from the real backend afterwards.
      await page.route(`**/api/v1/workspaces/${wsId}`, async (route: Route) => {
        if (route.request().method() === 'PATCH') {
          try {
            const body = route.request().postDataJSON() as { threadId?: string };
            if (body?.threadId) capturedThreadId = body.threadId;
          } catch {
            // not JSON / no threadId in this PATCH — ignore
          }
        }
        await route.fallback();
      });

      // GET .../workspaces/:id/chat/:threadId — the workspace Chat tab's
      // hydrate() call. Matches any threadId since it isn't known until the
      // PATCH above has round-tripped.
      await page.route(`**/api/v1/workspaces/${wsId}/chat/**`, async (route: Route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }
        const messagesAfter = [
          {
            kind: 'task_run_marker',
            id: 'marker-start-1',
            taskId: 'live-task-started-1',
            taskTitle,
            phase: 'start',
          },
        ];
        await route.fulfill({
          json: {
            messages: sseDelivered ? messagesAfter : messagesBefore,
            summaryPath: null,
            summarizedAt: null,
          },
        });
      });

      await page.route('**/api/v1/events', async (route: Route) => {
        await eventsGate.promise;
        sseDelivered = true;
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: `data: ${JSON.stringify({
            type: 'task_started',
            threadId: capturedThreadId,
            taskId: 'live-task-started-1',
          })}\n\n`,
        });
      });

      await page.goto(`/workspaces/${wsId}`);
      await page.getByRole('button', { name: 'Chat' }).click();

      // Wait for WorkspaceChatTab's threadId-assignment effect to complete
      // (captured above) — this is what use-live-events.ts's
      // hasThreadInstance(event.threadId) needs to match, and what this
      // test's fix specifically covers: the old activeThreadId-only gate
      // never worked for this tab at all.
      await expect.poll(() => capturedThreadId).not.toBeNull();
      await expect(page.getByTestId('task-run-marker')).toHaveCount(0);

      await pauseBeforeAction(page, testInfo);
      eventsGate.release();

      const marker = page.getByTestId('task-run-marker');
      await expect(marker).toBeVisible();
      await expect(marker).toContainText('Automated task started:');
      await expect(marker).toContainText(taskTitle);
    });

    test('hitl_prompt broadcast shows the "waiting on you" banner and the pending prompt live in the workspace Chat tab', async ({
      page,
      request,
    }, testInfo) => {
      const wsId = await createWorkspace(request, 'live-events-hitl-prompt-ws');

      const taskTitle = 'Automated live-hitl task';
      const question = 'Should I proceed with this destructive step?';

      // "Before" state: the task has already started (its start marker is
      // already in the thread) but hasn't hit the HITL pause yet — mirrors
      // task-execution.ts's real ordering (recordTaskRunMarker('start') runs
      // long before the hitl_prompt/'end' marker pair that follows a pause).
      const messagesBefore = [
        {
          kind: 'task_run_marker',
          id: 'marker-start-1',
          taskId: 'live-task-hitl-1',
          taskTitle,
          phase: 'start',
        },
      ];

      // "After" state adds both rows task-execution.ts writes when a run
      // pauses on ask_user: the pending hitl_prompt message itself (renders
      // the Approve/Deny-equivalent controls) and the 'end' task_run_marker
      // with outcome: 'waiting_on_user' (renders the "waiting on you" text)
      // — two separate message rows, not one.
      const messagesAfter = [
        ...messagesBefore,
        {
          kind: 'hitl_prompt',
          id: 'hitl-1',
          promptId: 'prompt-hitl-1',
          question,
          promptKind: 'yes_no',
          status: 'pending',
        },
        {
          kind: 'task_run_marker',
          id: 'marker-end-1',
          taskId: 'live-task-hitl-1',
          taskTitle,
          phase: 'end',
          outcome: 'waiting_on_user',
        },
      ];

      let capturedThreadId: string | null = null;
      let sseDelivered = false;
      const eventsGate = deferredGate();

      await page.route(`**/api/v1/workspaces/${wsId}`, async (route: Route) => {
        if (route.request().method() === 'PATCH') {
          try {
            const body = route.request().postDataJSON() as { threadId?: string };
            if (body?.threadId) capturedThreadId = body.threadId;
          } catch {
            // not JSON / no threadId in this PATCH — ignore
          }
        }
        await route.fallback();
      });

      await page.route(`**/api/v1/workspaces/${wsId}/chat/**`, async (route: Route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback();
          return;
        }
        await route.fulfill({
          json: {
            messages: sseDelivered ? messagesAfter : messagesBefore,
            summaryPath: null,
            summarizedAt: null,
          },
        });
      });

      await page.route('**/api/v1/events', async (route: Route) => {
        await eventsGate.promise;
        sseDelivered = true;
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: `data: ${JSON.stringify({
            type: 'hitl_prompt',
            threadId: capturedThreadId,
            taskId: 'live-task-hitl-1',
          })}\n\n`,
        });
      });

      await page.goto(`/workspaces/${wsId}`);
      await page.getByRole('button', { name: 'Chat' }).click();

      await expect.poll(() => capturedThreadId).not.toBeNull();

      // "Before" state: the start marker is visible, but neither the
      // waiting-on-you end marker nor the pending prompt's question exist yet.
      await expect(page.getByTestId('task-run-marker')).toHaveCount(1);
      await expect(page.getByText(question, { exact: true })).not.toBeVisible();

      await pauseBeforeAction(page, testInfo);
      eventsGate.release();

      await expect(page.getByTestId('task-run-marker')).toHaveCount(2);
      const endMarker = page.getByTestId('task-run-marker').last();
      await expect(endMarker).toContainText('Automated task waiting on you:');
      await expect(endMarker).toContainText(taskTitle);
      await expect(page.getByText(question, { exact: true })).toBeVisible();
    });
  },
);
