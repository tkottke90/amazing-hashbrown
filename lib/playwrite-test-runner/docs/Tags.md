# Tagging Strategy

In **Playwright**, tags are a _grouping mechanism_. Our recommendation on best practice is to only create groups when you have identified a specific pattern (such as tests that can only run in CI). Tags let you run a subset of your suites — for example, only fast smoke tests before a deploy, or only user-facing workflows — using Playwright's `--grep`/`--grep-invert` flags.

This library ships a small `TAGS` enum with five values. You don't have to use them — plain strings work as tags too — but they give you a shared vocabulary if your team wants one.

## Available tags

| Tag                  | Value            | When to use it                                                                                                                                                                                                            |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAGS.UserWorkflow`  | `@user-workflow` | Tests that follow the actions of an end user completing a specific task. Typically applied at the suite level.                                                                                                            |
| `TAGS.Functional`    | `@functional`    | Tests that focus on non-user workflows, such as automation triggered via an API, webhook, or message queue rather than a person clicking through the UI. Typically applied at the suite level.                            |
| `TAGS.Smoke`         | `@smoke`         | Simple, quick-to-validate checks — the primary driver for sanity checks after a release. Smoke tests should **not** make any data changes; they only validate that things are running as expected.                        |
| `TAGS.Comprehensive` | `@comprehensive` | Full validation of a process or step. Unlike smoke tests, these tests _should_ make real data changes to validate a capability end-to-end, and may need their own setup/cleanup to restore a base state before and after. |
| `TAGS.Accessability` | `@accessability` | Validates accessibility choices for end users — theme, motion, color-blindness preferences, and similar. (Note: this is the actual spelling used by the enum value.)                                                      |

## Common use-cases for tags

Tags are a general-purpose grouping mechanism, but two use-cases come up often enough to be worth calling out on their own. They're independent of each other — a suite can (and usually should) carry one tag from each:

- **Test type** — `TAGS.UserWorkflow` / `TAGS.Functional` answer _"what's driving this suite?"_: a person clicking around in the browser, or something automated (a queue, webhook, schedule). See [Test Types](./TestTypes.md) for the full breakdown and a decision heuristic for picking one.
- **Test depth** — `TAGS.Smoke` / `TAGS.Comprehensive` answer _"how thorough is this particular check?"_: a fast, read-only sanity check you're comfortable running often (`Smoke`), or a full end-to-end validation that's allowed to change data and may need its own setup/cleanup (`Comprehensive`).

Because these two are independent, they combine on the same suite rather than replacing each other:

```ts
tag: [TAGS.UserWorkflow, TAGS.Smoke]; // a person-driven suite, kept fast and read-only
```

`TAGS.Accessability` is a third, narrower use-case: flagging suites or steps that specifically validate accessibility choices (theme, motion, color-blindness preferences), so they can be run or reviewed on their own.

## Suite-level vs. step-level tags

Tags can be applied on a [`TestSuite`](./TestSuite.md) (`tag: [...]`), on an individual [`TestStep`](./TestStep.md) (`tag: [...]`), or both:

- A suite-level tag applies to every step's test, since a suite maps to a single Playwright test.
- A step-level tag is layered on top of the suite's tags for that particular step.
- If a tag is already present at the suite level, adding the same tag at the step level is redundant — `suiteRunner()` automatically filters out step tags that duplicate a suite tag, so you never end up with a doubled-up tag in your reports.

## Example

```ts
const suite: TestSuite = {
  id: 2,
  name: 'Chat Interface',
  purpose: 'Verify a user can send and receive chat messages',
  tag: [TAGS.UserWorkflow], // applies to every step below
  steps: [
    {
      action: 'Open a new conversation',
      expectedOutcome: 'A new, empty thread is created',
      tag: [TAGS.Smoke], // this step is ALSO a smoke test
      test: async ({ page }) => {
        /* ... */
      },
    },
    {
      action: 'Send a message and receive a reply',
      expectedOutcome: 'The reply appears in the conversation',
      test: async ({ page }) => {
        /* no step-level tag needed — inherits @user-workflow from the suite */
      },
    },
  ],
};
```

**A note on `--grep` filtering:** `suite.tag`/`step.tag` are recorded on the running test (visible in the HTML report and JSON output) so you can see at a glance what each suite and step is meant to cover — but they're applied _while the test is running_, after Playwright has already decided which tests to run. Playwright's `--grep`/`--grep-invert` flags filter by matching against the test **title**, decided before any test code runs. So `tag` alone won't select which suites run via `--grep`. If you want to filter suite runs from the command line, include the tag directly in the suite's `name` (e.g. `name: 'Chat Interface @smoke'`) so it becomes part of the test title Playwright matches against.
