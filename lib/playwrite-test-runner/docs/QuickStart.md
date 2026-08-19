# Getting Started

This guide walks you through installing the library, wiring it into an existing Playwright project, and writing your first test suite. By the end you'll have one working, runnable test.

If you haven't used Playwright before, that's fine — this guide only assumes you have a Playwright project already set up (a `playwright.config.ts` and a way to run `npx playwright test`). If you don't have that yet, follow [Playwright's own installation guide](https://playwright.dev/docs/intro) first, then come back here.

## Installing

Install the library alongside Playwright's test runner, which it depends on:

```sh
npm install @tkottke90/playwrite-test-runner @playwright/test
```

## Setup & Configuration

No extra configuration is required. The library doesn't add its own config file or change how Playwright discovers tests — it works inside your existing spec files (the `*.spec.ts` files Playwright already picks up based on your `playwright.config.ts`).

There is one rule to keep in mind as you write spec files: **call `suiteRunner()` at most once per spec file.** Internally, `suiteRunner()` registers hooks (like `beforeEach`) and video recording settings at the top level of the file. If you call it twice in the same file, the second call's hooks and video settings can leak onto the first suite's test. If you want two suites, put them in two separate spec files.

## Your First Test Suite

A **test suite** is an object that describes a goal a user is trying to accomplish (its `purpose`) and the individual **steps** it takes to get there. Each step has a plain-language `action` and `expectedOutcome`, plus a `test` function that actually runs the check.

Create a new spec file — for example `upload.spec.ts` — with the following:

```ts
import { expect } from '@playwright/test';
import { suiteRunner, TAGS, type TestSuite } from '@tkottke90/playwrite-test-runner';

const FileUploadSuite: TestSuite = {
  id: 1,
  name: 'File Upload',
  purpose: 'Verify that a user can upload a document via the UI',
  tag: [TAGS.UserWorkflow],
  steps: [
    {
      action: 'Go to the upload page',
      expectedOutcome: 'The page loads and the upload form is visible',
      test: async ({ page }) => {
        await page.goto('/upload');

        await expect(page.getByRole('form')).toBeVisible();
      },
    },
    {
      action: 'Select a file and submit it',
      expectedOutcome: 'The file appears in the list of uploaded documents',
      test: async ({ page }) => {
        await page.getByLabel('Choose file').setInputFiles('fixtures/sample.pdf');
        await page.getByRole('button', { name: 'Upload' }).click();

        await expect(page.getByText('sample.pdf')).toBeVisible();
      },
    },
  ],
};

suiteRunner(FileUploadSuite);
```

A few things worth noticing:

- `id` and `name` identify the suite in test reports — Playwright will show this test as `[1] File Upload`.
- `purpose` explains *why* this suite exists. This is the detail that's easy to lose in a plain Playwright test file, and the whole reason this library exists (see [Overview](./Overview.md)).
- Each step's `test` function receives `{ page }`, the same Playwright `Page` object you'd use in a regular Playwright test.
- `tag: [TAGS.UserWorkflow]` marks this as a user-facing workflow test. See [Tags](./Tags.md) for what each tag means and when to use it.
- You never call `test()` or `test.step()` yourself — `suiteRunner()` does that for you, running each step in order against one shared `page`.

Run it the same way you'd run any Playwright test:

```sh
npx playwright test upload.spec.ts
```

## Where to go next

- [TestSuite](./TestSuite.md) and [TestStep](./TestStep.md) — full field-by-field reference for what you can put in a suite and a step
- [Tags](./Tags.md) — how to classify suites and steps so they can be filtered in CI
- [Video Controls](./VideoControl.md) — record a video of a suite running, useful for reviewing PRs
- [Test Types](./TestTypes.md) — the difference between a user workflow test and a functional test
