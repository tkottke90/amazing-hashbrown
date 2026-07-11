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

| Tag              | When to use                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `@smoke`         | Fast check of core functionality; runs frequently                   |
| `@user-workflow` | Simulates a user completing a task in the UI                        |
| `@functional`    | Non-user-facing flow: health checks, webhooks, system integrations  |
| `@comprehensive` | Full feature verification run to completion; used after deployments |

Every test describe block must carry exactly one type tag.

### Runtime-requirement tag

| Tag    | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `@llm` | Requires a live Ollama/LLM endpoint; excluded from CI via `--grep-invert "@llm"` |

A test that sends a chat message and awaits a real LLM response carries both
tags, e.g. `test.describe('@user-workflow @llm', () => { ... })`.

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

## Selector strategy

Prefer selectors in this order:

1. `data-testid` — added to UI source explicitly for test targeting
2. `aria-label` — ARIA attributes already on interactive elements
3. `data-slot` — component-level slot markers used throughout the UI

Never select by CSS class, element tag alone, or DOM hierarchy. These are
implementation details that change without notice.

### Known `data-testid` attributes in UI source

| Attribute value     | Component file                            | Added for                                          |
| ------------------- | ----------------------------------------- | -------------------------------------------------- |
| `assistant-message` | `ui/src/components/assistant-message.tsx` | Targeting assistant response bubbles in @llm tests |

When you add a new `data-testid` to a UI source file, record it in the table
above so future test authors can discover it without grepping the whole
codebase.
