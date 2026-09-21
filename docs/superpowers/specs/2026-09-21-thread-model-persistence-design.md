# Thread model persistence on reload

## Problem

Reloading a chat thread shows the default model in the chip instead of the
provider/model persisted in the thread's metadata, even though the API
already returns the thread's real model. See [#195](https://github.com/tkottke90/amazing-hashbrown/issues/195).

**Root cause, confirmed in code (more precise than the issue's own
writeup):** `hydrate()` in `ui/src/hooks/use-thread.ts` fetches
`GET /api/v1/threads/:id`, whose response (`ClientThreadDetail`, extending
`ThreadSummary` in `api/src/services/thread-store.ts`) has always included
`provider`/`model` — but `hydrate()` only reads `messages` and
`summaryPath` out of that response and silently drops the rest.

Separately, `activeThreadModel` starts `null` per `ThreadInstance`, and an
`effect()` auto-fills it with the default the moment `/api/v1/providers`
resolves — an unrelated fetch with no ordering relationship to thread
hydration. `switchThread()` is the only place that tries to apply a
persisted model, and it reads it from the sidebar list signal
(`threads.value`), populated by a third, separately-fired,
unawaited fetch (`refreshThreadList()`). On a hard reload there's no
sequencing between these three fetches: `switchThread()` usually reads
`threads.value` before `refreshThreadList()`'s fetch resolves, so the
persisted model is skipped, and the provider-list fetch wins the race with
the default.

This bug isn't confined to `use-thread.ts`. `WorkspaceChatTab`
(`ui/src/pages/workspaces/workspace-chat-tab.tsx`) has the same
`activeThreadModel`-driven model chip and calls `thread.hydrate()`
directly — it never goes through `switchThread()` at all, so it has no
mechanism whatsoever for restoring a persisted model, on reload or
otherwise.

## Goals

- Reloading a thread shows that thread's persisted provider/model, not the
  global default.
- A thread with no persisted model still falls back to the default model,
  once we've actually confirmed (via `hydrate()`) that there isn't one —
  never by guessing before we know.
- Switching threads in-session continues to show each thread's own model,
  with a snappy chip update rather than a blank flash when opening a
  thread not yet visited this session.
- The fix is shared, not duplicated per call site: global chat, workspace
  chat, and wiki ingestion chat all restore persisted models correctly,
  since they all route through the same `hydrate()`.

## Fix — `hydrate()` becomes the single source of truth

`hydrate()` already fetches the one response that authoritatively knows
this thread's persisted model. Every caller (`ChatRoot`/`switchThread`,
`WorkspaceChatTab`, wiki ingestion) already awaits it. The fix moves model
restoration there instead of depending on the sidebar list and its
ordering relative to other fetches.

1. Add a `modelHydrated` signal to `ThreadInstance` (starts `false`).
2. In `hydrate()`, once the fetch settles — success, 404 (fresh thread),
   or the network-error catch branch — treat that as "we now know
   whether this thread has a persisted model." Batch together:
   - If the response has both `provider` and `model`, set
     `activeThreadModel` to them **unconditionally** — this deliberately
     overrides a default the auto-fill effect may have already guessed
     in the meantime, since `hydrate()`'s data is authoritative.
   - Set `modelHydrated = true`.
3. The default auto-fill `effect()` gets a second guard condition: only
   apply the default when `modelHydrated === true` AND
   `activeThreadModel === null`. It no longer races the provider-list
   fetch against thread hydration — it just waits until `hydrate()` has
   spoken, then fires reactively once providers are also loaded (the
   effect already re-runs when `providers.value` changes).
4. `switchThread()` keeps its existing optimistic pre-fill of
   `activeThreadModel` from the already-loaded sidebar list
   (`threads.value`) before calling `hydrate()`. This is now a pure UX
   optimization, not a correctness path: it avoids a blank chip while
   `hydrate()`'s round-trip is in flight when switching to a thread not
   yet instantiated this session. `hydrate()` confirms or corrects it
   right after, since it's already awaited there.

### Why this eliminates the race

Previously, two unrelated fetches (`/api/v1/providers` vs.
`/api/v1/threads`) determined which one reached the model chip first.
After this fix, only one fetch matters for correctness —
`hydrate()`'s own response — and every code path already awaits it before
doing anything else with the thread. The sidebar list is no longer a
correctness dependency anywhere.

### Edge cases

- **Fresh thread, no persisted model:** `hydrate()` leaves
  `activeThreadModel` untouched, sets `modelHydrated = true`; the auto-fill
  effect supplies the default once providers are ready.
- **Reload with a persisted model:** applied directly from `hydrate()`'s
  own response, regardless of provider-fetch timing.
- **In-session switch to an already-visited thread:** `modelHydrated` is
  already `true` and `activeThreadModel` already holds a real value from a
  prior hydration — `switchThread()`'s optimistic write is a no-op
  re-assignment, `hydrate()` re-confirms.
- **In-session switch to a never-visited thread:** `switchThread()`'s
  optimistic write from `threads.value` shows the right model immediately
  if the sidebar already knows it; otherwise the chip stays blank for one
  round-trip until `hydrate()` resolves and the gated auto-fill effect
  fires — never a wrong-then-corrected flash.
- **Network error on `hydrate()`:** still sets `modelHydrated = true` in
  the catch branch, so the chip eventually falls back to the default
  instead of staying blank forever on a degraded page.

## Testing

Per `AGENTS.md`, application code ships with tests in the same PR.

**Jest unit tests** (`ui/test/use-thread.test.ts`):

- `hydrate()` applies a persisted `provider`/`model` from its response to
  `activeThreadModel`.
- `hydrate()`'s persisted value overrides an already-applied default — the
  actual race from the bug report: set a default first, then call
  `hydrate()` with a different persisted model, assert the override wins.
- No persisted model in the response → `activeThreadModel` stays `null`
  and `modelHydrated` becomes `true`; the auto-fill effect only applies
  the default once `modelHydrated` is `true`, never before.
- `switchThread()`'s optimistic pre-fill from `threads.value`, followed by
  `hydrate()` confirming/correcting it.

**Playwright E2E** (`@user-workflow` or `@functional`): mock
`/api/v1/providers` and `/api/v1/threads/:id` via `page.route()` with the
provider-list response resolving _before_ the thread-detail response —
the ordering that caused the original bug — and assert the model chip
shows the thread's persisted model after reload, not the default. Forcing
this ordering matters because a fast local run might not otherwise
reproduce the race.
