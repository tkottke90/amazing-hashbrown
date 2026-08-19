# playwrite-test-runner/AGENTS.md

Instructions for agents (and humans) using this library.

## What this is

`@tkottke90/playwrite-test-runner` is a thin wrapper around [Playwright](https://playwright.dev/docs/intro)'s test runner. Instead of writing individual `test()` calls, you describe a **test suite**: a goal (`purpose`) plus an ordered list of **steps**, each with a plain-language `action` and `expectedOutcome`. The library turns that description into one real Playwright test. It's aimed at developers who are new to writing automated tests — you don't need to know Playwright's advanced APIs to get value from it, and it doesn't replace plain Playwright tests where you need them.

## Install

```sh
npm install @tkottke90/playwrite-test-runner @playwright/test
```

## Core concepts at a glance

- **`TestSuite`** — an object describing a goal and its `steps`. One `TestSuite` becomes one Playwright test.
- **`TestStep`** — one action/expected-outcome pair within a suite, plus the `test` function that actually runs.
- **`suiteRunner(suite)`** — registers a `TestSuite` as a real Playwright test. Call it once per spec file.
- **`pauseForVideo(page, suite, testInfo)`** — adds a short pause during a recorded run so the video is watchable; a no-op when not recording.
- **`TAGS`** — a shared enum of tag values (`UserWorkflow`, `Functional`, `Smoke`, `Comprehensive`, `Accessability`) for classifying suites and steps.

## Where to find more

| Question | Doc |
| --- | --- |
| How do I install and write my first suite? | [docs/QuickStart.md](./docs/QuickStart.md) |
| Why does this library exist / when should I use it? | [docs/Overview.md](./docs/Overview.md) |
| What fields can a `TestSuite` have? | [docs/TestSuite.md](./docs/TestSuite.md) |
| What fields can a `TestStep` have? | [docs/TestStep.md](./docs/TestStep.md) |
| What are the two testing conventions this library expects? | [docs/TestTypes.md](./docs/TestTypes.md) |
| How do I tag and filter suites/steps? | [docs/Tags.md](./docs/Tags.md) |
| How do I record and pace a video of a suite? | [docs/VideoControl.md](./docs/VideoControl.md) |

## Known constraints

- **Call `suiteRunner()` at most once per spec file.** It registers hooks (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`) and the `recordVideo` setting at the top level of the file rather than inside a `describe()` block. A second `suiteRunner()` call in the same file will leak its hooks and video setting onto the first suite's test. See [docs/TestSuite.md](./docs/TestSuite.md#running-a-suite).
- **If you're working inside the `amazing-hashbrown` monorepo, note that this library's `TestSuite` shape is not the same as that repo's root `TestSuite` convention.** The repo's root `AGENTS.md` describes a project-wide documentation convention with `description` and `tags: string[]` fields (used, for example, by `e2e/lib/suite.ts`'s hand-rolled helper). This library's actual, enforced `TestSuite` interface — the one `suiteRunner()` accepts — uses `purpose` and `tag` instead, and has no `description` field. When writing tests with this library, follow the interface documented in [docs/TestSuite.md](./docs/TestSuite.md), not that repo's root convention. This note is only relevant within that monorepo; it doesn't apply to other consumers of this package.
