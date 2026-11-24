import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { createTodoistTrackerAdapter, TODOIST_API } from './tracker-todoist.js';

// Targets Todoist's unified API v1 (developer.todoist.com/api/v1, as of
// 2026-11). Response bodies below mirror that reference's task, project,
// label and paginated-list shapes. Re-check if Todoist ships a v2.

interface RecordedRequest {
  path: string; // URL with TODOIST_API stripped
  method: string;
  auth: string | null;
  body: unknown;
}

interface MockResponse {
  status?: number;
  body?: unknown;
}

type Route = (req: RecordedRequest) => MockResponse | undefined;

const originalFetch = globalThis.fetch;

// Serves each request from the first route that returns a response; any
// unrouted request fails the test loudly instead of hanging on the network.
function mockTodoist(...routes: Route[]): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const req: RecordedRequest = {
      path: url.startsWith(TODOIST_API) ? url.slice(TODOIST_API.length) : url,
      method: init?.method ?? 'GET',
      auth: headers['Authorization'] ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    for (const route of routes) {
      const res = route(req);
      if (res) {
        const status = res.status ?? 200;
        return new Response(status === 204 ? null : JSON.stringify(res.body ?? {}), { status });
      }
    }
    throw new Error(`Unmocked Todoist request: ${req.method} ${req.path}`);
  }) as typeof fetch;
  return calls;
}

function on(method: string, pathPrefix: string, res: MockResponse): Route {
  return (req) => (req.method === method && req.path.startsWith(pathPrefix) ? res : undefined);
}

const ACTIVE_TASK = {
  id: '6X7rM8997g3RQmvh',
  content: 'Buy milk',
  description: '',
  project_id: '6Jf8VQXxpwv56VQ7',
  labels: ['errands'],
  due: { date: '2026-12-01', string: 'Dec 1', is_recurring: false },
  checked: false,
};

const NOT_FOUND: MockResponse = { status: 404, body: { error: 'Task not found' } };
const FIXED_NOW = new Date('2026-11-24T12:00:00Z');

function adapter(token: string | undefined) {
  return createTodoistTrackerAdapter(token, { now: () => FIXED_NOW });
}

const TOKEN = 'todoist_token';

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the promise to reject');
}

describe('adapters/tracker-todoist', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('configuration', () => {
    it('reports configured and canCreate only when a token is present [unit]', () => {
      expect(adapter(undefined).configured).to.equal(false);
      expect(adapter(undefined).canCreate).to.equal(false);
      expect(adapter(TOKEN).configured).to.equal(true);
      expect(adapter(TOKEN).canCreate).to.equal(true);
    });

    it('refuses every API-backed call without a token, and never hits the network [unit]', async () => {
      const calls = mockTodoist();
      const a = adapter(undefined);
      expect(await rejection(a.getItem('x'))).to.contain('not configured');
      expect(await rejection(a.createItem({ title: 'x' }))).to.contain('not configured');
      expect(await rejection(a.listContainers!())).to.contain('not configured');
      expect(await rejection(a.setAssignee!('x', 'user'))).to.contain('not configured');
      expect(calls, 'no request should be made without a token').to.have.length(0);
    });
  });

  describe('resolveUrl()', () => {
    it('resolves a task URL to its title, pending state and due date, authenticating with the token [external-orchestration]', async () => {
      const calls = mockTodoist(on('GET', `/tasks/${ACTIVE_TASK.id}`, { body: ACTIVE_TASK }));
      const item = await adapter(TOKEN).resolveUrl(
        `https://app.todoist.com/app/task/${ACTIVE_TASK.id}`,
      );
      expect(item).to.deep.equal({
        id: ACTIVE_TASK.id,
        url: `https://app.todoist.com/app/task/${ACTIVE_TASK.id}`,
        title: 'Buy milk',
        state: 'pending',
        trackerState: 'active',
        dueAt: '2026-12-01',
      });
      expect(calls[0]!.auth).to.equal('Bearer todoist_token');
    });

    it("accepts the web app's slugged URL form and extracts the id from the end [external-orchestration]", async () => {
      const calls = mockTodoist(on('GET', `/tasks/${ACTIVE_TASK.id}`, { body: ACTIVE_TASK }));
      await adapter(TOKEN).resolveUrl(
        `https://app.todoist.com/app/task/buy-milk-${ACTIVE_TASK.id}`,
      );
      expect(calls[0]!.path).to.equal(`/tasks/${ACTIVE_TASK.id}`);
    });

    it("rejects another tracker's URL locally, without a network call, so any-adapter resolution stays fast [unit]", async () => {
      const calls = mockTodoist();
      const message = await rejection(
        adapter(TOKEN).resolveUrl('https://github.com/octo/repo/issues/1'),
      );
      expect(message).to.contain('Not a recognised Todoist task URL');
      expect(calls).to.have.length(0);
    });

    it('refuses to link a completed or missing task (404) with a clear message [external-orchestration]', async () => {
      mockTodoist(on('GET', '/tasks/', NOT_FOUND));
      const message = await rejection(
        adapter(TOKEN).resolveUrl('https://app.todoist.com/app/task/abc123'),
      );
      expect(message).to.equal("Todoist task is completed or doesn't exist");
    });
  });

  describe('getItem()', () => {
    it('returns an active task as pending [external-orchestration]', async () => {
      mockTodoist(on('GET', `/tasks/${ACTIVE_TASK.id}`, { body: ACTIVE_TASK }));
      const item = await adapter(TOKEN).getItem(ACTIVE_TASK.id);
      expect(item.state).to.equal('pending');
    });

    it('finds a completed task in the last 3 months of completions and reports it as done [external-orchestration]', async () => {
      const calls = mockTodoist(
        on('GET', '/tasks/completed/by_completion_date', {
          body: {
            items: [{ ...ACTIVE_TASK, checked: true, completed_at: '2026-11-20T10:00:00Z' }],
            next_cursor: null,
          },
        }),
        on('GET', '/tasks/', NOT_FOUND),
      );
      const item = await adapter(TOKEN).getItem(ACTIVE_TASK.id);
      expect(item.state).to.equal('done');
      expect(item.trackerState).to.equal('completed');
      const scan = calls.find((c) => c.path.startsWith('/tasks/completed'))!;
      const query = new URLSearchParams(scan.path.split('?')[1]);
      const windowDays =
        (Date.parse(query.get('until')!) - Date.parse(query.get('since')!)) / 86_400_000;
      expect(windowDays, 'scan window must stay inside the API 3-month limit').to.be.at.most(90);
      expect(query.get('until')).to.equal(FIXED_NOW.toISOString());
    });

    it('follows next_cursor across pages of completed tasks until the task is found [external-orchestration]', async () => {
      const calls = mockTodoist(
        (req) =>
          req.path.startsWith('/tasks/completed') && !req.path.includes('cursor=')
            ? { body: { items: [{ ...ACTIVE_TASK, id: 'other' }], next_cursor: 'page2' } }
            : undefined,
        on('GET', '/tasks/completed', { body: { items: [ACTIVE_TASK], next_cursor: null } }),
        on('GET', '/tasks/', NOT_FOUND),
      );
      const item = await adapter(TOKEN).getItem(ACTIVE_TASK.id);
      expect(item.state).to.equal('done');
      expect(calls.filter((c) => c.path.startsWith('/tasks/completed'))).to.have.length(2);
      expect(calls.some((c) => c.path.includes('cursor=page2'))).to.equal(true);
    });

    it('fails when the task is neither active nor recently completed (deleted, or completed long ago) [external-orchestration]', async () => {
      mockTodoist(
        on('GET', '/tasks/completed', { body: { items: [], next_cursor: null } }),
        on('GET', '/tasks/', NOT_FOUND),
      );
      expect(await rejection(adapter(TOKEN).getItem('gone'))).to.contain('not found');
    });

    it('surfaces a non-404 API error instead of treating it as completed [external-orchestration]', async () => {
      mockTodoist(on('GET', '/tasks/', { status: 401, body: { error: 'Unauthorized' } }));
      expect(await rejection(adapter(TOKEN).getItem('x'))).to.contain('401');
    });

    it('reports dueAt as null when the task has no due date, and as the date part when it has a time [unit]', async () => {
      mockTodoist(
        on('GET', '/tasks/nodue', { body: { ...ACTIVE_TASK, id: 'nodue', due: null } }),
        on('GET', '/tasks/timed', {
          body: { ...ACTIVE_TASK, id: 'timed', due: { date: '2026-12-01T09:30:00' } },
        }),
      );
      expect((await adapter(TOKEN).getItem('nodue')).dueAt).to.equal(null);
      expect((await adapter(TOKEN).getItem('timed')).dueAt).to.equal('2026-12-01');
    });
  });

  describe('createItem()', () => {
    it('creates a task in the chosen project with description and due date [external-orchestration]', async () => {
      const calls = mockTodoist(on('POST', '/tasks', { body: ACTIVE_TASK }));
      const item = await adapter(TOKEN).createItem({
        title: 'Buy milk',
        body: 'Semi-skimmed',
        container: '6Jf8VQXxpwv56VQ7',
        dueAt: '2026-12-01',
      });
      expect(calls[0]!.body).to.deep.equal({
        content: 'Buy milk',
        description: 'Semi-skimmed',
        project_id: '6Jf8VQXxpwv56VQ7',
        due_date: '2026-12-01',
      });
      expect(item.id).to.equal(ACTIVE_TASK.id);
    });

    it("omits project_id when no container is chosen, so Todoist uses the user's Inbox [external-orchestration]", async () => {
      const calls = mockTodoist(on('POST', '/tasks', { body: ACTIVE_TASK }));
      await adapter(TOKEN).createItem({ title: 'Buy milk', dueAt: null });
      expect(calls[0]!.body).to.deep.equal({ content: 'Buy milk' });
    });

    it('surfaces an API error from Todoist on create [external-orchestration]', async () => {
      mockTodoist(on('POST', '/tasks', { status: 400, body: { error: 'Invalid project_id' } }));
      expect(
        await rejection(adapter(TOKEN).createItem({ title: 'x', container: 'bad' })),
      ).to.contain('400');
    });
  });

  describe('listContainers()', () => {
    it('walks every page of projects and returns id/name pairs [external-orchestration]', async () => {
      const calls = mockTodoist(
        (req) =>
          req.path.startsWith('/projects') && !req.path.includes('cursor=')
            ? { body: { results: [{ id: 'p1', name: 'Inbox' }], next_cursor: 'c2' } }
            : undefined,
        on('GET', '/projects', {
          body: { results: [{ id: 'p2', name: 'Work', color: 'red' }], next_cursor: null },
        }),
      );
      const projects = await adapter(TOKEN).listContainers!();
      expect(projects).to.deep.equal([
        { id: 'p1', name: 'Inbox' },
        { id: 'p2', name: 'Work' },
      ]);
      expect(calls).to.have.length(2);
      expect(calls[0]!.path).to.contain('limit=200');
    });
  });

  describe('setAssignee()', () => {
    const LABELS_PAGE = (names: string[]): MockResponse => ({
      body: { results: names.map((name, i) => ({ id: `l${i}`, name })), next_cursor: null },
    });

    it("adds AH:User while keeping the user's own labels [external-orchestration]", async () => {
      const calls = mockTodoist(
        on('GET', '/labels', LABELS_PAGE(['errands', 'AH:User'])),
        on('GET', `/tasks/${ACTIVE_TASK.id}`, { body: ACTIVE_TASK }),
        on('POST', `/tasks/${ACTIVE_TASK.id}`, { body: ACTIVE_TASK }),
      );
      await adapter(TOKEN).setAssignee!(ACTIVE_TASK.id, 'user');
      const update = calls.find((c) => c.method === 'POST' && c.path.startsWith('/tasks/'))!;
      expect(update.body).to.deep.equal({ labels: ['errands', 'AH:User'] });
    });

    it('swaps AH:User for AH:Agent on reassignment, touching no other label [external-orchestration]', async () => {
      const calls = mockTodoist(
        on('GET', '/labels', LABELS_PAGE(['AH:Agent'])),
        on('GET', '/tasks/t1', { body: { ...ACTIVE_TASK, id: 't1', labels: ['AH:User', 'home'] } }),
        on('POST', '/tasks/t1', { body: ACTIVE_TASK }),
      );
      await adapter(TOKEN).setAssignee!('t1', 'agent');
      const update = calls.find((c) => c.method === 'POST' && c.path === '/tasks/t1')!;
      expect(update.body).to.deep.equal({ labels: ['home', 'AH:Agent'] });
    });

    it("creates the label first when it doesn't exist yet in the user's account [external-orchestration]", async () => {
      const calls = mockTodoist(
        on('GET', '/labels', LABELS_PAGE(['errands'])),
        on('POST', '/labels', { body: { id: 'new', name: 'AH:Agent' } }),
        on('GET', `/tasks/${ACTIVE_TASK.id}`, { body: ACTIVE_TASK }),
        on('POST', `/tasks/${ACTIVE_TASK.id}`, { body: ACTIVE_TASK }),
      );
      await adapter(TOKEN).setAssignee!(ACTIVE_TASK.id, 'agent');
      const created = calls.find((c) => c.method === 'POST' && c.path === '/labels');
      expect(created, 'missing label should be created').to.not.equal(undefined);
      expect(created!.body).to.deep.equal({ name: 'AH:Agent' });
      const createIdx = calls.indexOf(created!);
      const updateIdx = calls.findIndex(
        (c) => c.method === 'POST' && c.path === `/tasks/${ACTIVE_TASK.id}`,
      );
      expect(createIdx, 'label must exist before it is applied').to.be.lessThan(updateIdx);
    });

    it('removes every AH: label for a null assignee, without creating any label [external-orchestration]', async () => {
      const calls = mockTodoist(
        on('GET', '/tasks/t1', {
          body: { ...ACTIVE_TASK, id: 't1', labels: ['AH:User', 'AH:Agent', 'home'] },
        }),
        on('POST', '/tasks/t1', { body: ACTIVE_TASK }),
      );
      await adapter(TOKEN).setAssignee!('t1', null);
      const update = calls.find((c) => c.method === 'POST')!;
      expect(update.body).to.deep.equal({ labels: ['home'] });
      expect(calls.some((c) => c.path.startsWith('/labels'))).to.equal(false);
    });

    it('makes no write when the task already carries exactly the right label [external-orchestration]', async () => {
      const calls = mockTodoist(
        on('GET', '/tasks/t1', { body: { ...ACTIVE_TASK, id: 't1', labels: ['AH:User'] } }),
      );
      await adapter(TOKEN).setAssignee!('t1', 'user');
      expect(calls.filter((c) => c.method === 'POST')).to.have.length(0);
    });

    it('is a no-op for a completed or deleted task (404) rather than an error [external-orchestration]', async () => {
      const calls = mockTodoist(on('GET', '/tasks/', NOT_FOUND));
      await adapter(TOKEN).setAssignee!('gone', 'user');
      expect(calls.filter((c) => c.method === 'POST')).to.have.length(0);
    });
  });
});
