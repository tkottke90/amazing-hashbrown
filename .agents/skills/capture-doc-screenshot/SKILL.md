---
name: capture-doc-screenshot
description: >
  Capture a real screenshot of the running Amazing Hashbrown app (not a mockup
  or a description) for docs-site documentation, using a local Playwright
  script driven directly from the shell. Use this skill whenever the user
  asks to add, capture, update, or redo a screenshot for the docs; whenever a
  docs-site page has a "<!-- Screenshot Needed -->" placeholder; or whenever
  you're documenting a UI feature and need to actually show what it looks
  like, even if the user just says "add a picture of X" or "show what the
  settings page looks like" without saying the word "screenshot." Do NOT use
  the browser MCP tool for this — it runs in a sandboxed container that
  cannot hand screenshot files back to this filesystem, so any screenshot
  meant to become a real file in this repo has to go through this skill's
  approach instead. Enforces this repo's screenshot rules: saved under
  docs-site/content/assets/, wrapped in an HTML <figure> + <figcaption>, and
  at least 16px of padding around the captured subject on every side.
---

# Capturing docs-site screenshots

A documentation screenshot in this repo has to be a real capture of the
actual running app — not a mockup, not an AI-generated approximation. That
means driving a real browser against the real local dev servers. This skill
is the recipe for doing that reliably, plus the three hard output rules
every capture must follow.

## Why not the browser MCP tool

It's tempting to reach for the browser automation MCP tool (`browser_navigate`,
`browser_take_screenshot`, etc.) since it's already available. Don't, for
this task specifically — it runs the actual browser in a separate sandboxed
container, and there is no way to get the resulting PNG bytes out of that
container into this repo's filesystem. You can drive it and reason about
what's on the page, but the screenshot file itself is unreachable. Write and
run a local Playwright script instead — the `e2e` workspace already has
`@playwright/test` (and Chromium) installed, so `node your-script.mjs` from
anywhere in the repo works with no extra setup.

## The workflow

### 1. Get the app running

Check first, don't blindly start — someone (a person, another task) may
already have it up, and you should only stop what you personally started:

```sh
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/v1/wiki/domains  # API
curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/                     # UI
```

If either isn't responding, start it (in the background, so you can keep
working while it boots):

```sh
npm run build:libs                                    # only needed once per session
CONFIG_DIR='../config' npm run dev --workspace api     # port 3000
npm run dev --workspace ui                             # port 5173, proxies /api to :3000
```

Note which of these you actually started — that's what you'll tear down in
step 5, and only that.

### 2. Find the real selectors — don't guess them

Read the component you're capturing under `ui/src/pages/**` (or wherever it
lives) to get the actual class names, `data-testid`s, and interaction model
(does hovering show something? does a click toggle a class? does an
animation/simulation need time to settle?). Guessing selectors from what the
rendered page probably looks like wastes a round trip; the source has the
real answer. If e2e tests already exercise the feature
(`e2e/tests/*.spec.ts`), they're often the fastest way to find working
selectors — they've already solved this exact problem once.

### 3. Write a short driver script

This is a one-off, not something to commit — write it anywhere convenient
(a scratch/tmp path is fine) and delete it in step 5. Import the shared
helpers from `scripts/screenshot-helpers.mjs` in this skill's directory
rather than re-deriving the padding/clip math each time:

```js
import { chromium } from 'playwright';
import { unionBoundingBox, paddedClip } from '<this-skill-dir>/scripts/screenshot-helpers.mjs';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:5173/wiki', { waitUntil: 'networkidle' });

// Let any layout animation/simulation actually finish before you touch it —
// measuring or interacting too early gets you a stale position, and a
// screenshot taken mid-transition. Graph force-layouts in this app take a
// few seconds to settle; other views may not need this at all.
await page.waitForTimeout(4000);

// ...trigger whatever state you're documenting (hover, click, etc.)...

const box = await unionBoundingBox(page, ['selector-for-the-thing', 'and-anything-else-in-frame']);
const clip = paddedClip(box, { pad: 16, viewport: { width: 1400, height: 900 } });

await page.screenshot({ path: 'docs-site/content/assets/<descriptive-name>.png', clip });
await browser.close();
```

A few things that reliably cause bad captures, learned the hard way:

- **Measure after settling, not right after triggering.** If you hover an
  element and immediately read its bounding box, you can catch it mid
  CSS-driven size/position change (e.g. a hover-triggered radius bump).
  Trigger the interaction, wait briefly, *then* measure.
- **Union multiple elements when the subject is more than one thing.** A
  hovered node plus the card that appears next to it are one visual subject
  — pad around both together, not just the first one you thought of.
- **Cap runaway dimensions.** An isolated/outlier element can sit far from
  the rest of the content and blow the union box up into an image that's
  mostly dead white space. Capping `maxWidth`/`maxHeight` and letting that
  one outlier fall outside the frame makes a far more useful screenshot than
  technically including everything — legibility beats completeness here.
- **Use real interactions, not `force: true` clicks/hovers, when the app's
  own JS reads live mouse position** (e.g. a card positioned at the cursor's
  coordinates). `force: true` skips Playwright's actionability checks and
  can leave the app's internal mouse-tracking state stale.

### 4. Wire it into the docs

Every screenshot in a doc page is wrapped in a `<figure>`, matching the
convention already established in
`docs-site/content/docs/llm-wiki/002-graph-view.md`:

```html
<figure class="flex flex-col items-center text-center">
  <img src="{{ '/assets/<descriptive-name>.png' | url }}" alt="<describe what's shown, not just what it's a screenshot of>">
  <figcaption><short caption></figcaption>
</figure>
```

Write a real, specific `alt` — "a screenshot of the settings page" tells a
screen-reader user nothing; "Dark mode toggle switched on in Settings" does.

If you're filling in a `<!-- Screenshot Needed: ... -->` placeholder, that
comment's text is your brief — replace the whole comment with the figure
above (and a sentence or two of surrounding prose if the section doesn't
have any yet).

### 5. Verify and clean up

- Rebuild the docs site (`npx eleventy` from `docs-site/`) and grep the
  output HTML for your new `<img>` tag to confirm it resolved and landed
  where you expect — don't just trust that the markdown looks right.
- Delete the scratch driver script.
- Stop only the dev server(s) you started in step 1 — if the app was already
  running before you began, leave it running.
- If you made any temporary config changes purely to get a capture working
  (there shouldn't be any need to, going through `localhost` directly), undo
  them.

## The three hard rules

Every screenshot produced by this skill must satisfy all three, no
exceptions:

1. **≥16px of padding** around the captured subject on every side (use
   `paddedClip`'s `pad` option — don't hand-roll this differently).
2. **Saved under `docs-site/content/assets/`** — this is the directory
   `.eleventy.js`'s `addPassthroughCopy` actually copies into the built
   site. (There is no other correct location; `content/images/` is a
   retired convention.)
3. **Wrapped in `<figure><img>...<figcaption>...</figure>`** in the doc page
   — never a bare markdown `![]()` image for anything captured by this
   skill.
