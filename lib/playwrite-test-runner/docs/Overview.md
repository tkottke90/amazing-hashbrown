# Overview

The Playwright Test Runner library is a wrapper library around [Playwright](https://playwright.dev/docs/intro) and is designed to enrich automated software tests and provide a standardized structure for writing tests.

## Why this exists

The primary use-case we found for Playwright was writing automated tests to replace the manual testing we were doing. This allowed us to build new features, and quickly measure the impact on existing features (regression testing) without having to manually go through our entire application each time we made a change.

## Where it fits

It is important to note that this **does not replace traditional Playwright tests** where advanced usage is needed, or in repositories where you already have that type of testing in place. This library is simply meant to help you organize tests, and provide more detailed information around how each test was written and what it validates — an _encouraged_ structure, not an enforced one. You can adopt it for some suites and write plain Playwright tests elsewhere in the same project.

## Where to go next

- [QuickStart](./QuickStart.md) — install the library and write your first test suite
- [AGENTS.md](../AGENTS.md) — a short map of every concept and where its detailed docs live
