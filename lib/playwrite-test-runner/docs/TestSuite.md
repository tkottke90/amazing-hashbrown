# Test Suites

The _Playwright Test Runner_ is built around a core concept of a _Test Suite_. This outlines not only the test to be run but also gives developers a place to store metadata about those tests. This can help in maintaining the test as well as helping non-technical readers understand what the tests represent.

A `TestSuite` becomes exactly one Playwright test when you pass it to [`suiteRunner()`](./TestSuite.md#running-a-suite) — its `steps` run in order, one after another, sharing a single `page`.

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `number` | Yes | A number that identifies this suite. Shown in test reports as part of the test title, e.g. `[1] File Upload`. |
| `name` | `string` | Yes | A short, human-readable name for the suite. Shown alongside `id` in test reports. |
| `purpose` | `string` | Yes | Plain-language explanation of *why* this suite exists — what user value it validates. Recorded as a Playwright annotation (`suite.purpose`) so it's visible in the HTML report, not just in the source file. |
| `steps` | [`TestStep[]`](./TestStep.md) | Yes | The ordered list of steps that make up this suite. See [TestStep](./TestStep.md) for what each step can contain. |
| `beforeAll` | `(args, testInfo) => void \| Promise<void>` | No | Runs once before any step, via Playwright's `test.beforeAll`. Receives `{ page }`. |
| `afterAll` | `(args, testInfo) => void \| Promise<void>` | No | Runs once after all steps, via Playwright's `test.afterAll`. Receives `{ page }`. |
| `beforeEach` | `(args, testInfo) => void \| Promise<void>` | No | Runs via Playwright's `test.beforeEach`. Because a suite maps to exactly one test, this effectively runs once per suite run, before the suite's single test body starts. |
| `afterEach` | `(args, testInfo) => void \| Promise<void>` | No | Runs via Playwright's `test.afterEach`, once per suite run. |
| `startingPage` | `string` | No | Documents the URL/route the suite starts from. Currently informational only — `suiteRunner()` does not navigate for you; your first step should still call `page.goto(...)` if needed. |
| `recordVideo` | `boolean` | No | When set, overrides the Playwright project's own video-recording setting for this suite's test (`true` forces recording on, `false` forces it off). Leave unset to use whatever your `playwright.config.ts` already has configured. See [Video Controls](./VideoControl.md). |
| `tag` | `string \| string[]` | No | One or more tags applied to every step in the suite (inherited from Playwright's `TestDetails`). See [Tags](./Tags.md). |
| `slow` / `skip` / `fail` / `fixme` | `boolean \| string \| (() => boolean \| string)` | No | Standard Playwright test markers, applied to the whole suite. A `string` value both marks the test and records the string as the reason. |

## Example

```ts
import { expect } from '@playwright/test';
import { suiteRunner, TAGS, type TestSuite } from '@tkottke90/playwrite-test-runner';

const CheckoutSuite: TestSuite = {
  id: 4,
  name: 'Checkout',
  purpose: 'Verify a signed-in user can complete a purchase',
  tag: [TAGS.UserWorkflow],
  recordVideo: true,
  beforeEach: async ({ page }) => {
    await page.goto('/login');
    // ...sign in a test user...
  },
  steps: [
    // one or more TestStep objects — see docs/TestStep.md
  ],
};

suiteRunner(CheckoutSuite);
```

## Running a suite

Pass a `TestSuite` to `suiteRunner(suite)` to register it as a real Playwright test. This is the only function you need to call — you don't write `test()` or `test.describe()` yourself.

```ts
import { suiteRunner } from '@tkottke90/playwrite-test-runner';

suiteRunner(CheckoutSuite);
```

**Call `suiteRunner()` at most once per spec file.** Its hooks (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`) and `recordVideo` setting are registered at the top level of the file, not scoped inside a `test.describe()` block — Playwright doesn't allow a video-recording override (`test.use({ video })`) inside a `describe()` at all. That means if you call `suiteRunner()` twice in one file, the second suite's hooks and video setting will also apply to the first suite's test, and vice versa. If you need more than one suite, give each its own spec file.
