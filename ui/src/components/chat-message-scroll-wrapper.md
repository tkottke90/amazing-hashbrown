# ChatMessageScrollWrapper

Wraps a chat message list and manages scroll behavior. On load it snaps instantly to the bottom. Thereafter it smooth-scrolls as content grows — but only while the user is already near the bottom. If the user has scrolled up to read an older message, auto-scroll is suppressed entirely until they return to the bottom.

## Exports

| Export                          | Type      | Description                          |
| ------------------------------- | --------- | ------------------------------------ |
| `ChatMessageScrollWrapper`      | Component | The scroll-managing container        |
| `ChatMessageScrollWrapperProps` | Interface | Props for `ChatMessageScrollWrapper` |

## `ChatMessageScrollWrapper`

### Props

| Prop        | Type                | Default | Description                                                                                                 |
| ----------- | ------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `children`  | `ComponentChildren` | —       | The message list to render. Observed for size changes to trigger auto-scroll.                               |
| `className` | `string`            | —       | Extra classes merged onto the outer scroll container. Use this to constrain height (`flex-1 min-h-0`, etc.) |

### Basic usage

```tsx
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';

<ChatMessageScrollWrapper className="flex-1 min-h-0">
  {messages.map((m) => (
    <ChatMessage key={m.id} message={m.text} sentAt={m.sentAt} />
  ))}
</ChatMessageScrollWrapper>;
```

---

## Layout recipes

The wrapper applies `overflow-y-auto` but does not constrain its own height. A bounded height must come from the parent layout; without one the container grows to fit its content, the scrollbar never appears, and all scroll logic silently has no effect.

### Flex column (most common)

A full-height chat shell with a fixed header and input bar. `flex-1 min-h-0` lets the wrapper absorb the remaining space while `min-h-0` overrides the flex default that would otherwise let it overflow its parent.

```tsx
<div className="flex h-screen flex-col">
  <Header />
  <ChatMessageScrollWrapper className="flex-1 min-h-0">{messages}</ChatMessageScrollWrapper>
  <ChatInput />
</div>
```

### Grid row

When the shell uses a named grid layout, assign the wrapper to the message row and let the grid track size set the height.

```tsx
<div className="grid h-screen grid-rows-[auto_1fr_auto]">
  <Header />
  <ChatMessageScrollWrapper className="min-h-0">{messages}</ChatMessageScrollWrapper>
  <ChatInput />
</div>
```

### Fixed viewport panel

For a floating chat widget or a sidebar panel with a known height.

```tsx
<div className="fixed bottom-4 right-4 flex h-[600px] w-96 flex-col rounded-xl border shadow-xl">
  <ChatMessageScrollWrapper className="flex-1 min-h-0">{messages}</ChatMessageScrollWrapper>
  <ChatInput />
</div>
```

### Inside the app Layout component

The `Layout` component's main content area is a flex column. Apply `flex-1 min-h-0` to fill it and pass any padding via `className` rather than on a wrapper div, so the scroll container reaches the full height.

```tsx
<Layout aside={<AppAside />}>
  <ChatMessageScrollWrapper className="flex-1 min-h-0 px-4 py-6">
    {messages}
  </ChatMessageScrollWrapper>
</Layout>
```

---

## Troubleshooting

### Scroll never appears / auto-scroll does nothing

The container has no bounded height. The symptom is that all messages are visible at once with no scrollbar. Fix: ensure the parent establishes a height and the wrapper gets `flex-1 min-h-0` (flex) or `min-h-0` (grid) — see [Layout recipes](#layout-recipes) above.

A quick check in devtools: inspect the wrapper element and confirm `clientHeight` is less than `scrollHeight`. If they are equal and both match the total content height, the container is unconstrained.

### Scroll snaps to bottom on every new message even when reading history

The sentinel is never leaving the viewport, which means the container itself is not the scroll root — a parent element is doing the scrolling instead. This can happen when `overflow-y-auto` on the parent intercepts scroll before it reaches the wrapper. Remove `overflow-y-auto` / `overflow-y-scroll` from ancestors, or restructure so the wrapper is the only scrollable element in the chain.

### Smooth scroll feels laggy during fast streaming

The browser's native smooth scroll can lag behind rapid `scrollTo` calls. If tokens arrive faster than the animation completes, each new call interrupts the previous one. Consider debouncing the `ResizeObserver` callback or switching `behavior` to `'instant'` once token throughput exceeds a threshold.

### Content jumps on initial load instead of snapping

The instant scroll runs after the first paint, so a very large history may flash at the top briefly before snapping. Pre-render the list with `visibility: hidden`, snap to bottom, then make it visible — or virtualise the message list so only the last N messages mount initially.

---

## Scroll behavior

### On load — instant snap

When the component mounts, `scrollTop` is set directly to `scrollHeight` with no animation. This avoids a visible scroll animation when the conversation history first renders.

### While streaming — smooth scroll

When a message's content grows (e.g. a streaming LLM response appending tokens) and the bottom of the list is visible, the container smooth-scrolls to follow the new content. The smooth transition gives the user a sense of motion without being jarring.

### While reading history — no scroll

If the user scrolls up to read an older message, auto-scroll is suppressed. New content may still arrive at the bottom (streaming continues), but the viewport stays wherever the user left it. Auto-scroll resumes automatically the next time the user scrolls back to the bottom.

---

## Implementation details

### Bottom sentinel

A zero-height `<div>` sits below the content wrapper inside the scroll container. An `IntersectionObserver` with `root` set to the scroll container watches this element. When it intersects (is on-screen), the user is at or near the bottom; when it leaves the viewport, they have scrolled up.

### Content observer

A `ResizeObserver` watches the inner content wrapper. Whenever its height increases — due to a new message being appended or an existing message growing — the observer checks the sentinel state and fires a smooth scroll if appropriate.

### Initial-layout guard

`ResizeObserver` fires once during initial layout before any user interaction. A two-frame `requestAnimationFrame` gate prevents this burst from triggering a redundant smooth scroll on top of the instant mount scroll.
