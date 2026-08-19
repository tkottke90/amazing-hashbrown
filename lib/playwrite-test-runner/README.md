# Playwright Test Runner

Playwright provide a way to run browser and api based e2e tests against your real application. Allowing you to codify tests that you would otherwise run manually in a repeatable way. Where playwright lacks is in the ability to organize tests into suites with meaningful metadata (tags, justifications, expected outcomes, etc). This library provides a way to organize your tests into suites with metadata and then run them using playwright.

The challenge I was facing was answering this question "what value is added by a test". Many testing libraries like Playwright, Mocha, Jest do a great job at the individual unit-level explanation:

```ts
test('clicking on the file picker should open a system dialog', async () => {});

test('dragging a file into the file picker should add it to the pending upload list', async () => {});

test('file should display on the page with the size after selection', async () => {});

test('loading spinner should be shown while a file is uploading', async () => {});
```

What I found lacking was clear documentation on _why_ we were testing this or "_what value was being validated_". Overtime this becomes bloat or "cruft" as new work is added. We loose a sense on _why_ a test was written in the first place but we do not remove it for fear of breaking things.

This library looks attack that gap. Instead of simply defining tests, you define **test suites**. This requires that you provide information such as the **purpose for the tests**, and for each step **what action is taken** and **what is the expected outcome**.

## Installation

```sh
npm install @tkottke90/playwrite-test-runner @playwright/test
```

## Documentation

- [AGENTS.md](./AGENTS.md) — quick orientation and a map to the detailed docs
- [docs/QuickStart.md](./docs/QuickStart.md) — install, configure, and write your first test suite

## Example

```ts
import { TestSuite } from '@tkottke90/playwrite-test-runner';

export const FileUploadSuite: TestSuite = {
  id: 1,
  name: 'Test',
  purpose: 'Verify that a user can upload a document via the UI',
  steps: [
    {
      action: 'Go to the upload page',
      expectedOutcome: 'The page should load and the upload form visible',
      test: ({ page }) => {
        page.goto('/');

        const input = page.getByRole('form').first();

        expect(input, 'File Input should be visible').toBeVisible();
      },
    },
  ],
};
```
