# Test Types

To help with organization, this library follows a convention around automated testing types. Every [`TestSuite`](./TestSuite.md) you write should fit one of 2 core types. Picking the right one isn't just bookkeeping — it shapes how you write the suite: who or what is "acting" in each step, how much setup/cleanup you need, and which tag you apply so the suite is easy to find and filter later.

## User Workflow Tests

Tests where a **person** is driving the action, the same way a real user would: clicking buttons, filling out forms, navigating between pages, searching, uploading a file, sending a chat message. Each step's `test` function calls Playwright APIs like `page.click(...)`, `page.getByLabel(...).fill(...)`, or `page.getByRole('button', ...).click()` — the same things a human would do with a mouse and keyboard.

These tests verify that a user's experience doesn't regress when changes are applied, or that a regression is caught before release rather than discovered by an actual user.

Tag these suites with `TAGS.UserWorkflow` (`@user-workflow`) — see [Tags](./Tags.md).

**Examples:**

- A user uploads a document and sees it appear in their file list
- A user fills out and submits a checkout form
- A user searches for an item and the results update

## Functional Tests

Tests where the action is driven by something **other than a person clicking around in the browser**: a message on a queue, an incoming webhook, a scheduled job, a file watcher noticing a new file, one service calling another's API. The `page` object may still be used (e.g. to check that a result eventually shows up in the UI), but the *trigger* for the step is not a person navigating and clicking — it's automated or indirect.

Because the trigger is indirect, these suites typically need more setup than user workflow suites — you often have to prepare the queue message, seed the webhook payload, or drop a file into a watched folder yourself before you can observe the result.

Tag these suites with `TAGS.Functional` (`@functional`) — see [Tags](./Tags.md).

**Examples:**

- A queued job processes a pending export and marks it complete
- An incoming webhook creates a record that later shows up in the UI
- A nightly cleanup job removes expired sessions

## How to decide which type applies

Ask one question about the suite as a whole: **"Is a person clicking, typing, or navigating to make this happen?"**

- Yes → **User Workflow Test**
- No — it's triggered by a queue, webhook, schedule, or another system → **Functional Test**

If a suite's first step is a person logging in and clicking around, but a later step waits on a background job to finish, it's still a User Workflow Test — the type describes what triggers the overall suite, not every individual step inside it.

## Test type vs. test depth

Test type (`UserWorkflow`/`Functional`) is a different concern from test *depth* (`TAGS.Smoke`/`TAGS.Comprehensive`, also covered in [Tags](./Tags.md)) — the two combine rather than replace each other:

- **Type** answers *"what's driving this suite?"* — a person in the browser, or something automated.
- **Depth** answers *"how thorough is this particular check?"* — a fast sanity check that makes no data changes (`Smoke`), or a full end-to-end validation that's allowed to change data and may need its own setup/cleanup (`Comprehensive`).

A single suite carries exactly one type tag, and can also carry a depth tag:

```ts
const suite: TestSuite = {
  id: 5,
  name: 'File Upload',
  purpose: 'Verify that a user can upload a document via the UI',
  tag: [TAGS.UserWorkflow, TAGS.Smoke], // a user-driven suite, kept fast and read-only
  steps: [/* ... */],
};
```

### Applying depth at the step level

Because `suiteRunner()` turns a whole suite into exactly one Playwright test (see [TestSuite](./TestSuite.md#running-a-suite)), a suite-level depth tag can only describe the suite *as a whole* — it can't tell you that one particular step inside an otherwise light suite is actually the risky one. Tagging depth on an individual [`TestStep`](./TestStep.md) gives you that finer control.

A common shape: most of a suite's steps are read-only navigation/assertion checks, but one step near the end actually mutates data. Tagging the suite `Smoke` and calling out just that one step as `Comprehensive` documents exactly which action in the flow needs a seeded record and cleanup — without marking the whole suite (and every fast, read-only step in it) as `Comprehensive`, and without splitting one coherent user flow into two separate suites:

```ts
const suite: TestSuite = {
  id: 6,
  name: 'Account Deletion',
  purpose: 'Verify a user can permanently delete their account from settings',
  tag: [TAGS.UserWorkflow, TAGS.Smoke], // the suite overall is a quick sanity check
  steps: [
    {
      action: 'Open account settings and locate the delete-account option',
      expectedOutcome: 'The "Delete Account" button is visible and enabled',
      test: async ({ page }) => {
        // read-only — no data changes
      },
    },
    {
      action: 'Confirm the deletion dialog explains data loss is permanent',
      expectedOutcome: 'The confirmation dialog is shown with a clear warning',
      test: async ({ page }) => {
        // still read-only
      },
    },
    {
      action: 'Click "Delete Account" and confirm',
      expectedOutcome: 'The account is deleted and the user is signed out',
      tag: [TAGS.Comprehensive], // the one step that actually mutates data
      test: async ({ page }, testInfo) => {
        // deletes a seeded test account — needs cleanup, unlike the steps above
      },
    },
  ],
};
```

As the [note on `--grep` filtering](./Tags.md) explains, this step-level tag won't let you *run* just that one step separately — the suite is still one test. What it gives you instead is an honest, per-step record in the test report: anyone reading the suite's source, or reviewing a failure in the HTML report, can see at a glance that steps 1–2 are safe, read-only checks while step 3 is the one action in this "smoke" suite that actually changes data and requires a seeded account. That distinction is exactly what a single suite-level tag can't express on its own.

## Where this fits

- [TestSuite](./TestSuite.md) — where the `tag` field actually lives on a suite
- [Tags](./Tags.md) — the full list of tag values, including `Smoke`, `Comprehensive`, and `Accessability`
