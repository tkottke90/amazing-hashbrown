# Test Steps

Each _action_ the user can take is captured in a `TestStep`. A [`TestSuite`](./TestSuite.md) is a list of these steps, run one after another against a single shared page. Where the suite describes the overall goal, each step describes one specific action along the way and what should happen as a result.

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `string` | Yes | Plain-language description of what this step does, e.g. `'Select a file and submit it'`. This is **not** executed — it's documentation, recorded as a Playwright annotation (`step.action`) and used in the step's title in test reports. |
| `expectedOutcome` | `string` | Yes | Plain-language description of what should happen after the action, e.g. `'The file appears in the list of uploaded documents'`. Also **not** executed — it's documentation only, recorded as a `step.expectedOutcome` annotation. The actual pass/fail check happens in `test`. |
| `test` | `(args, testInfo) => void \| Promise<void>` | Yes | The function that actually runs. Receives `{ page }` (a Playwright `Page`) and Playwright's `testInfo`. This is where you drive the browser and make assertions with `expect(...)`. |
| `tag` | `string \| string[]` | No | One or more tags applied to this step specifically, in addition to any tags on the parent suite. See [Tags](./Tags.md) — note that a tag already present on the suite is automatically skipped here, so you don't need to repeat suite-level tags on every step. |
| `slow` / `skip` / `fail` / `fixme` | `boolean \| string \| (() => boolean \| string)` | No | Standard Playwright test markers, applied to this step. A `string` value both marks the step and records the string as the reason. |

## Why `action` and `expectedOutcome` aren't executable

It's tempting to think `expectedOutcome` is where your assertions go — it isn't. Think of `action` and `expectedOutcome` as the caption you'd write for a manual test case in a test plan document: a human-readable summary of what's being verified. The `test` function is where you actually write the Playwright code (`page.click(...)`, `expect(...).toBeVisible()`, etc.) that proves the outcome really happened.

Keeping the two separate means someone reviewing a test report — or someone who isn't a developer at all — can understand what a suite verifies just from the `action`/`expectedOutcome` text, without reading code.

## Example

```ts
{
  action: 'Select a file and submit it',
  expectedOutcome: 'The file appears in the list of uploaded documents',
  tag: [TAGS.Smoke],
  test: async ({ page }, testInfo) => {
    await page.getByLabel('Choose file').setInputFiles('fixtures/sample.pdf');
    await page.getByRole('button', { name: 'Upload' }).click();

    await expect(page.getByText('sample.pdf')).toBeVisible();
  },
}
```

See [TestSuite](./TestSuite.md) for how steps fit into a full suite, and [Video Controls](./VideoControl.md) for `pauseForVideo()`, which you'll often call at the start of a step's `test` function.
