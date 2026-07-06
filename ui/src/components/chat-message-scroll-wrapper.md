# ChatMessageScrollWrapper

Wraps a chat message list and manages scroll behavior. On load it snaps instantly to the bottom. Thereafter it smooth-scrolls as content grows — but only while the user is already near the bottom. If the user has scrolled up to read an older message, auto-scroll is suppressed entirely until they return to the bottom.

## Exports

| Export                              | Type      | Description                                      |
| ----------------------------------- | --------- | ------------------------------------------------ |
| `ChatMessageScrollWrapper`          | Component | The scroll-managing container                    |
| `ChatMessageScrollWrapperProps`     | Interface | Props for `ChatMessageScrollWrapper`             |

## `ChatMessageScrollWrapper`

### Props

| Prop        | Type                | Default | Description                                                                                                   |
| ----------- | ------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `children`  | `ComponentChildren` | —       | The message list to render. Observed for size changes to trigger auto-scroll.                                 |
| `className` | `string`            | —       | Extra classes merged onto the outer scroll container. Use this to constrain height (`flex-1 min-h-0`, etc.)   |

### Basic usage

```tsx
import { ChatMessageScrollWrapper } from '@/components/chat-message-scroll-wrapper';

<ChatMessageScrollWrapper className="flex-1 min-h-0">
  {messages.map(m => (
    <ChatMessage key={m.id} message={m.text} sentAt={m.sentAt} />
  ))}
</ChatMessageScrollWrapper>
```

### Inside a flex layout

The wrapper must have a bounded height to scroll — it will not constrain itself. Inside a flex column, give it `flex-1 min-h-0`:

```tsx
<div className="flex h-screen flex-col">
  <Header />
  <ChatMessageScrollWrapper className="flex-1 min-h-0 px-4 py-6">
    {messages}
  </ChatMessageScrollWrapper>
  <ChatInput />
</div>
```

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
