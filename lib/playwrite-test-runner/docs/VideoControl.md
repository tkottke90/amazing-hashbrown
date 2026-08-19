# Video Controls

Playwright can record a video of a test as it runs — very useful when you want to attach a recording to a pull request so a reviewer can *watch* the change work, rather than reading a wall of assertions. This library adds two small pieces of control on top of Playwright's own video recording: a per-suite override, and a pacing helper so recordings are actually watchable.

## Turning recording on or off for a suite: `recordVideo`

Your `playwright.config.ts` already has its own video setting (usually `'on'`, `'off'`, `'retain-on-failure'`, etc.), which applies to every test by default. Set `recordVideo` on a [`TestSuite`](./TestSuite.md) to override that default for this suite specifically:

```ts
const suite: TestSuite = {
  id: 3,
  name: 'Checkout',
  purpose: 'Verify a user can complete a purchase',
  recordVideo: true, // record this suite regardless of the project's default
  steps: [/* ... */],
};
```

- `recordVideo: true` — always record this suite's test, even if your config has video off.
- `recordVideo: false` — never record this suite's test, even if your config has video on.
- Leave `recordVideo` unset — use whatever your `playwright.config.ts` already has configured for video.

When a suite is being recorded, `suiteRunner()` also calls Playwright's `test.slow()` automatically, tripling the default timeout. This gives the extra pacing described below room to happen without the test timing out.

## Pacing a recording: `pauseForVideo()`

A test that runs at full speed produces a video where everything is a blur — actions and results fly by too fast to see. `pauseForVideo(page, suite, testInfo)` adds a short, fixed pause (3 seconds) so a viewer has a moment to see the "before" state before the next action plays out.

Two important behaviors:

- **It costs nothing when a suite isn't being recorded.** `pauseForVideo()` checks whether the suite is actually being recorded (via `recordVideo` or, if unset, your Playwright config) and only pauses if so. In a normal, non-recorded run it's a no-op — you can leave calls to it in your test code without slowing down everyday test runs.
- **`suiteRunner()` already calls it once per step, automatically**, right before your step's `test` function runs. You don't need to call it yourself just to pace between steps.

Call it yourself, from inside a step's `test` function, when you want extra pacing *within* a single step — for example, between filling in a form and clicking submit, so a viewer can see the filled-in state before the click happens:

```ts
{
  action: 'Fill out and submit the checkout form',
  expectedOutcome: 'The order confirmation page is shown',
  test: async ({ page }, testInfo) => {
    await page.getByLabel('Card number').fill('4242 4242 4242 4242');

    // Give a viewer a moment to see the filled-in form before we submit it.
    await pauseForVideo(page, suite, testInfo);

    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page.getByText('Order confirmed')).toBeVisible();
  },
}
```

Pass the same `suite` object the step belongs to, and the `testInfo` your `test` function was given as its second argument — `pauseForVideo()` uses both to determine whether this particular run is actually being recorded.
