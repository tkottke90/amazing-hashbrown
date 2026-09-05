# Chat Scroll: Force-to-Bottom on Submit — Design

**Date:** 2026-09-05
**Status:** Draft
**Related:** [Issue #128](https://github.com/tkottke90/amazing-hashbrown/issues/128)

---

## Goal

When a user submits a chat message, the message pane should unconditionally jump to the bottom — even if they were scrolled up reading history — and then keep following the streamed reply as it grows, exactly as it already does today when the user happens to already be near the bottom. Stop following the moment the user scrolls away again.

---

## Problem

`ChatMessageScrollWrapper` (`ui/src/components/chat-message-scroll-wrapper.tsx`) already implements "stick to bottom while near the bottom" via a bottom sentinel `IntersectionObserver` (`isNearBottomRef`) and a `ResizeObserver` that smooth-scrolls on content growth only when `isNearBottomRef.current` is `true`. Nothing about message *submission* is wired into this: if the user is scrolled up when they send a new message, `isNearBottomRef` stays `false`, so the new user bubble and the streaming reply that follows it can appear off-screen with no scroll to reveal them.

The wrapper is used identically in three places — `ui/src/pages/chat/index.tsx`, `ui/src/pages/workspaces/workspace-chat-tab.tsx`, `ui/src/pages/wiki/ingestion-chat.tsx` — each with its own `handleSend()` that calls a `sendMessage`-shaped function. All three render the same `ThreadMessage` union (`ui/src/types/thread-message.ts`) via `ThreadMessageItem`.

---

## Non-goals

- **Element-level tracking of the specific assistant message bubble.** The issue raises whether "agent message in view" should be judged by any part of that specific message being visible, versus the existing bottom-of-content sentinel. This design keeps the existing sentinel-based approach — reworking submission to re-arm it produces the same practical behavior in every case except a single assistant reply so long it overflows the viewport, where the sentinel requires scrolling all the way to the true bottom to resume sticking rather than just the message's top peeking back into view. That gap is accepted as a known edge case, not solved here.
- **Changing the sentinel/`IntersectionObserver` "stop following" logic.** It already does the right thing (flips `isNearBottomRef` to `false` as soon as the user scrolls away from the bottom) and needs no change.
- **Backfilling full unit-test coverage for the wrapper's pre-existing (unrelated) behavior**, such as the mount-scroll and generic resize-follow logic. This design adds the first test file for the component, but scopes it to the behavior being changed plus the minimum regression coverage needed to protect it.

---

## Design

### `ChatMessageScrollWrapper`

New optional prop:

```ts
interface ChatMessageScrollWrapperProps {
  children: ComponentChildren;
  className?: string;
  forceScrollTrigger?: number;
}
```

A parent bumps `forceScrollTrigger` (a simple incrementing counter) every time the user submits a message. A new effect watches it:

```ts
const hasSkippedInitialTriggerRef = useRef(true);

useEffect(() => {
  if (hasSkippedInitialTriggerRef.current) {
    hasSkippedInitialTriggerRef.current = false;
    return;
  }
  const container = containerRef.current;
  if (!container) return;
  isNearBottomRef.current = true;
  container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}, [forceScrollTrigger]);
```

- The skip-first-run guard stops this effect from firing (and double-scrolling) on mount, since `[forceScrollTrigger]` always runs once when the component first mounts regardless of the prop's initial value.
- Setting `isNearBottomRef.current = true` synchronously (rather than waiting for the sentinel's `IntersectionObserver` to catch up asynchronously) re-arms "stick" immediately, so the very next `ResizeObserver` growth event — from the streamed reply's content — continues to follow, satisfying "keep sticking as new content streams in."
- `behavior: 'smooth'` matches the existing streaming-follow scroll, avoiding a jarring instant jump when the user was scrolled far up.
- If `forceScrollTrigger` is omitted entirely, the effect runs once on mount and is swallowed by the skip-first-run guard — fully backward compatible with any future consumer that doesn't wire it up.

No other part of the wrapper changes. The existing mount-scroll effect, sentinel `IntersectionObserver` effect, and `ResizeObserver` effect are untouched.

### Call sites

`ThreadView` (`ui/src/pages/chat/index.tsx`), `WorkspaceChatTab` (`ui/src/pages/workspaces/workspace-chat-tab.tsx`), and `IngestionChat` (`ui/src/pages/wiki/ingestion-chat.tsx`) each get the same two-line addition:

```ts
const forceScrollTrigger = useSignal(0);

function handleSend() {
  const content = inputValue.value.trim();
  if (!content) return;
  forceScrollTrigger.value++;
  inputValue.value = '';
  // ...rest unchanged...
}
```

and pass `forceScrollTrigger={forceScrollTrigger.value}` to their `<ChatMessageScrollWrapper>`.

### Data flow on submit

`handleSend()` bumps `forceScrollTrigger` and calls the send function (`thread.sendMessage()` / `sendWikiMessage()`). `sendMessage()`'s optimistic append of the user bubble and empty streaming assistant bubble happens inside a synchronous `batch()` call before its first `await` (`ui/src/hooks/use-thread.ts:552-568`), so both signal writes land in the same render pass as the trigger bump. By the time the wrapper's new effect runs post-commit, `contentRef.current.scrollHeight` already reflects the newly appended bubbles.

### Rejected alternatives

- **Imperative ref (`forwardRef` + `useImperativeHandle`)** exposing `scrollToBottom()`: would avoid the extra per-page signal, but this codebase has no forwardRef precedent and otherwise consistently uses props/signals for this kind of reactive trigger (`ui/AGENTS.md`'s state-management guidance). Rejected in favor of matching house style.
- **Deriving the trigger from the message list itself** (e.g. detecting a new `kind: 'user'` message appended): would require the wrapper to understand `ThreadMessage.kind`, breaking its current type-agnostic `children` contract, for no real savings over an explicit trigger — all three call sites already have a `handleSend()` to bump a counter in.

---

## Error handling

| Case | Behavior |
| --- | --- |
| Rapid re-submit while a reply is still streaming | Counter increments again; effect re-fires, re-arms sticking, re-issues `scrollTo` — browsers retarget an in-flight smooth scroll natively, no queuing needed |
| `forceScrollTrigger` prop omitted by a future consumer | Effect runs once on mount, swallowed by the skip-first-run guard; no crash, no behavior change from today |
| Container not yet mounted / unmounted mid-effect | Guarded by the same `if (!container) return` pattern already used elsewhere in this file |
| User scrolls up during the forced smooth scroll, before it completes | Sentinel's `IntersectionObserver` flips `isNearBottomRef` back to `false` as soon as it detects the sentinel left the viewport — same race the existing code already tolerates, no special-casing added |

---

## Testing

**Unit** — new `ui/src/components/chat-message-scroll-wrapper.test.tsx` (first test file for this component; scoped to the new behavior, not a full backfill):

- Bumping `forceScrollTrigger` calls `scrollTo` with `{ top: scrollHeight, behavior: 'smooth' }`, even when the sentinel was not intersecting beforehand (user was scrolled up).
- After a bump, a subsequent `ResizeObserver` growth event still triggers a follow-scroll — proves `isNearBottomRef` was re-armed synchronously, without waiting for the `IntersectionObserver` to separately report the sentinel visible.
- Regression: once the sentinel reports not-intersecting again (user scrolled away), further content growth does *not* scroll — existing behavior, guarded against the new code path breaking it.
- The initial mount effect is not double-triggered by the new trigger effect (`scrollTo` called exactly once on mount).

Test approach: replace the no-op `IntersectionObserver`/`ResizeObserver` globals from `jest.setup.ts` with local capturing mocks so the test can manually fire the sentinel/resize callbacks, and stub `Element.prototype.scrollTo` to assert on call arguments (jsdom does not compute real scroll geometry).

**E2E** — new `e2e/tests/chat-scroll.spec.ts`, CI-safe (no `@llm` tag), following the established `page.route()` hydration-mock pattern documented in `e2e/AGENTS.md` (e.g. `hitl-shell-approval.spec.ts`):

1. Mock `GET /api/v1/threads/:id` to hydrate a thread with enough prior messages to overflow the viewport, and scroll the message pane up.
2. Send a new message; assert the view snaps to the bottom immediately.
3. Mock a multi-frame SSE reply; assert the view keeps following as each frame arrives.
4. Scroll up mid-stream; assert the next SSE frame does not move the scroll position.

Tagged `@user-workflow`.
