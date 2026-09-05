# e2e/AGENTS.md

Instructions for agents (and humans) working in the `e2e/` workspace.

## What this is

The `e2e/` package is a Playwright end-to-end test suite that runs against a
live instance of the application (API on port 3000, UI on port 5173). It is an
npm workspace sibling of `api/`, `ui/`, and `lib/*`.

Before writing or modifying tests here, read the **Testing** section of the
root [`AGENTS.md`](../AGENTS.md) for the project-wide testing philosophy and
conventions. The canonical guidance lives there and at the blog post referenced
in that file: https://tdkottke.com/blog/002-testing/

## How to run

```sh
# From the repo root:
npm run test:e2e      # full suite — requires Ollama running locally
npm run test:e2e:ci   # CI-safe subset — excludes @llm tests, no Ollama needed
```

Playwright starts both servers automatically via `webServer` in
`playwright.config.ts` — you do not need to start the API or UI manually
(unless you want to reuse already-running servers locally, which is the
default when `CI` is not set).

After a run, open `e2e/playwright-report/index.html` for the HTML report with
traces and screenshots.

## Tag conventions

Two independent tag axes are used in this package. Both are applied to
`test.describe` block titles so Playwright's `--grep` / `--grep-invert` can
filter on either axis independently.

### Test-type tags (from root AGENTS.md)

| Tag              | When to use                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `@smoke`         | Fast check of core functionality; runs frequently and against production. DOES NOT MAKE ANY CHANGES |
| `@user-workflow` | Simulates a user completing a task in the UI                                                        |
| `@functional`    | Non-user-facing flow: health checks, webhooks, system integrations                                  |
| `@comprehensive` | Full feature verification run to completion; used after deployments                                 |

Every test describe block must carry exactly one type tag.

### Runtime-requirement tag

| Tag    | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `@llm` | Requires a live Ollama/LLM endpoint; excluded from CI via `--grep-invert "@llm"` |

A test that sends a chat message and awaits a real LLM response carries both
tags, e.g. `test.describe('@user-workflow @llm', () => { ... })`.

### Suites gated on other external credentials

`@llm` is excluded from CI by tag (`--grep-invert`). A suite gated on a
_different_ external dependency — one that should still attempt to run in CI
whenever the credentials happen to be configured, rather than always being
excluded — uses a dynamic `skip` instead: `002-GitHubTrackerWorkflow.spec.ts`
hits the real GitHub API and skips itself with a descriptive reason when
`E2E_GITHUB_TOKEN`/`E2E_GITHUB_TEST_REPO` aren't set, via the new library's
`skip: () => condition ? 'reason' : false` (see below). Locally this means
the suite just no-ops without those env vars; in CI, adding the
corresponding secrets is what turns it on.

## The newer `@tkottke90/playwrite-test-runner` pattern

`001-ChatInterface.spec.ts` and `002-GitHubTrackerWorkflow.spec.ts` use
`lib/playwrite-test-runner` (see its own `AGENTS.md`/`docs/`) instead of the
`TestSuite`/`suiteAnnotations` pattern documented below — one `suiteRunner()`
call per file, with each step's `test` function actually executed (no
separate hand-written `test.describe()` block). New numbered spec files
(`NNN-PascalCase.spec.ts`) should follow that library's docs, not the
pattern below, which the rest of `e2e/tests/*.spec.ts` still uses.

## TestSuite pattern

Every spec file must declare a `TestSuite` object above the `test.describe`
block, capturing intent in plain language. This is the same interface defined
in the root AGENTS.md:

```ts
import { test, expect } from '@playwright/test';

const suite = {
  id: 1,
  name: 'Page Load',
  description: 'Verifies the application renders correctly on first load',
  purpose: 'Catch regressions in the initial render path before they reach users',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Navigate to /',
      expectedOutcome: 'Textarea is visible and send button is disabled',
      test: () => {},
    },
  ],
};

test.describe('@smoke @user-workflow', () => {
  // tests here
});
```

The `TestSuite` object is documentation — it is not imported by any runner.
Keep it accurate as the tests evolve.

## Mocking API responses with page.route()

Use `page.route()` to coordinate the app into a specific state when reaching
that state through the real backend would be slow, flaky, or impossible in
this environment (no live LLM configured for non-`@llm` runs, a rare error
branch, a state that only exists mid-way through a multi-step backend
process). This is standard for `@smoke` tests (see the tag table above —
"mocking APIs is acceptable") and legitimate in `@user-workflow` tests too
when the alternative is skipping real coverage of a reachable UI branch.

**SSE endpoints are not a special case.** The chat endpoints stream
`text/event-stream` responses, but that's still just an HTTP response body to
Playwright — `route.fulfill()` can return one or more `data: {...}\n\n` frames
as a single static string, and the client's stream parser handles it exactly
like a real (if instant) stream. There is nothing to "unstream" — write the
SSE event(s) your test needs and fulfill the route with them.

**Two established patterns**, both real examples worth copying rather than
reinventing:

1. **Mock hydration, not the live turn.** `hitl-shell-approval.spec.ts` mocks
   `GET /api/v1/threads` and `GET /api/v1/threads/:id` so a pending HITL
   prompt already exists when the page loads — no agent turn needs to run to
   produce it. This is almost always the easier lever: fake the _state the
   page reads on load_, not the live interaction that would normally produce
   it.

2. **Mock only enough to reach the UI state — leave the endpoint under test
   real.** `task-queue-widget.spec.ts`'s HITL pause/resume test uses the same
   hydration mock to render a pending prompt, but deliberately leaves
   `POST /api/v1/chat/:threadId/hitl` unmocked. Clicking "Yes" fires a real
   request at the real (locally-running) server, so the test both shows a
   real click driving the UI in its recorded video _and_ verifies real
   server-side behavior (the task scheduler actually pausing/resuming). If
   you mock the endpoint whose behavior is the thing under test, you've
   stopped testing your app and started testing your mock — only mock the
   parts that gate reaching the state, not the part you're verifying.

```ts
await page.route('**/api/v1/threads**', async (route) => {
  const url = new URL(route.request().url());
  const match = url.pathname.match(/^\/api\/v1\/threads(?:\/([^/]+))?$/);
  if (!match) return route.fallback(); // not a threads request — let it through

  const id = match[1];
  if (!id && route.request().method() === 'GET') {
    return route.fulfill({ json: [mockThread] });
  }
  if (id === mockThread.id && route.request().method() === 'GET') {
    return route.fulfill({ json: { ...mockThread, messages: [pendingPrompt] } });
  }
  await route.fallback();
});
// POST /api/v1/chat/:threadId/hitl is left unmocked — real request, real server.
```

## Selector strategy

Prefer selectors in this order:

1. `data-testid` — added to UI source explicitly for test targeting
2. `aria-label` — ARIA attributes already on interactive elements
3. `data-slot` — component-level slot markers used throughout the UI

Never select by CSS class, element tag alone, or DOM hierarchy. These are
implementation details that change without notice.

### Known `data-testid` attributes in UI source

| Attribute value            | Component file                                      | Added for                                                                                     |
| -------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `assistant-message`        | `ui/src/components/assistant-message.tsx`           | Targeting assistant response bubbles in @llm tests                                            |
| `workspace-row`            | `ui/src/pages/workspaces/index.tsx`                 | Selecting specific workspace rows; pair with `data-workspace-id`                              |
| `win-condition`            | `ui/src/pages/workspaces/[id].tsx`                  | Asserting project win condition card in Overview tab                                          |
| `git-chip`                 | `ui/src/pages/workspaces/[id].tsx`                  | Targeting the Git metadata chip to assert its `title` (remote URL)                            |
| `task-card`                | `ui/src/pages/workspaces/[id].tsx`                  | Selecting task cards in Kanban columns; pair with `data-task-id`                              |
| `task-plan`                | `ui/src/components/task-drawer.tsx`                 | Targeting the plan field section inside the task drawer                                       |
| `plan-step`                | `ui/src/components/task-drawer.tsx`                 | Individual plan step rows; pair with `data-done="true\|false"`                                |
| `plan-step-checkbox`       | `ui/src/components/task-drawer.tsx`                 | Checkbox inside a plan step row                                                               |
| `task-status-select`       | `ui/src/components/task-drawer.tsx`                 | Status `<select>` in the task drawer edit form                                                |
| `task-tracker-type-select` | `ui/src/components/task-drawer.tsx`                 | Tracker adapter `<select>` in the task drawer's Tracker section                               |
| `task-tracker-preview`     | `ui/src/components/task-drawer.tsx`                 | Linked-item preview card once a tracker link resolves                                         |
| `queue-widget`             | `ui/src/components/thread-sidebar.tsx`              | Sidebar queue widget container                                                                |
| `queue-current-task`       | `ui/src/components/thread-sidebar.tsx`              | Task name text inside the queue widget                                                        |
| `queue-status`             | `ui/src/components/thread-sidebar.tsx`              | Status line inside the queue widget                                                           |
| `inbox-empty`              | `ui/src/pages/inbox/index.tsx`                      | Empty state placeholder shown when inbox has no tasks                                         |
| `inbox-due-soon`           | `ui/src/pages/inbox/index.tsx`                      | Section wrapper for tasks with a due date                                                     |
| `inbox-no-due-date`        | `ui/src/pages/inbox/index.tsx`                      | Section wrapper for tasks with no due date                                                    |
| `inbox-task-row`           | `ui/src/pages/inbox/index.tsx`                      | Table row for an inbox task; pair with `data-task-id`                                         |
| `resource-card`            | `ui/src/components/resource-card-message.tsx`       | Targeting the resource card rendered after /create-workspace or /create-project               |
| `resource-card-open-link`  | `ui/src/components/resource-card-message.tsx`       | The card's Open control, navigating to `/workspaces/:id`                                      |
| `graph-edges`              | `ui/src/pages/wiki/graph-view.tsx`                  | Wrapper `<g>` around rendered edge `<line>` elements; count children to assert edge rendering |
| `graph-nodes`              | `ui/src/pages/wiki/graph-view.tsx`                  | Wrapper `<g>` around rendered node `<circle>` elements                                        |
| `chat-scroll-container`    | `ui/src/components/chat-message-scroll-wrapper.tsx` | Reading `scrollTop`/`scrollHeight` to assert auto-scroll behavior in `chat-scroll.spec.ts`    |

When you add a new `data-testid` to a UI source file, record it in the table
above so future test authors can discover it without grepping the whole
codebase.
