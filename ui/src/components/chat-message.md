# ChatMessage

Renders a single chat message in a three-row CSS grid: timestamp, body, and a metadata/actions bar. Supports mirrored layout for user vs. assistant messages and composable action buttons.

## Exports

| Export | Type | Description |
|---|---|---|
| `ChatMessage` | Component | The primary message display component |
| `ChatMessageCopyAction` | Component | Copy-to-clipboard action button |
| `ChatMessageForkAction` | Component | Fork-conversation action button |
| `ChatMessageSaveAction` | Component | Save-to-file action button |
| `ChatMessageProps` | Interface | Props for `ChatMessage` |
| `ChatMessageCost` | Interface | Shape of the `cost` prop |

## `ChatMessage`

### Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `message` | `string` | — | The message content. Rendered as Markdown via the `Markdown` component. |
| `sentAt` | `Date` | — | When the message was sent. Displayed as a relative time within 24 h ("just now", "5m ago", "3h ago") and as a full locale string for older messages. |
| `mirrored` | `boolean` | `false` | Reverses the bottom row so actions sit on the outer edge and cost on the inner edge. Use `true` for user messages (right-aligned context) and `false` for assistant messages. |
| `cost` | `ChatMessageCost` | — | Optional token and dollar cost metadata shown in the bottom-left (or bottom-right when mirrored). |
| `duration` | `number` | — | Response duration in milliseconds. Shown centred in the bottom row. Omit for user messages. |
| `actions` | `ComponentChildren` | — | Action buttons rendered in the bottom-right (or bottom-left when mirrored). Compose with the exported action components. |
| `showBG` | `boolean` | `false` | Wraps the message body in a card surface (`bg-card`, `shadow-md`, rounded corners). Useful for assistant messages to visually separate them from the page background. |
| `className` | `string` | — | Extra classes applied to the outer grid wrapper. |

### `ChatMessageCost`

```ts
interface ChatMessageCost {
  tokensPerSecond?: number; // displayed as "12.3 tok/s"
  dollars?: number;         // displayed as "$0.0042"
}
```

Both fields are optional. Either, both, or neither may be provided.

### Grid layout

The component uses CSS named grid areas across three rows and three columns:

```
"time  time   time"
"msg   msg    msg"
"cost  timing actions"   // default (assistant)
"actions timing cost"    // mirrored (user)
```

The outer wrapper is `max-w-[80%]` to leave breathing room on wide viewports.

### Time formatting

| Age | Display |
|---|---|
| < 60 s | "just now" |
| < 60 min | "Xm ago" |
| < 24 h | "Xh ago" |
| ≥ 24 h | `date.toLocaleString()` |

### Cost stacking

On viewports narrower than `sm` (640 px) the tok/s and dollar spans stack vertically to prevent wrapping inside the narrow grid column.

### Basic usage

```tsx
import { ChatMessage } from '@/components/chat-message';

<ChatMessage
  message="Hello! How can I help you today?"
  sentAt={new Date()}
/>
```

### Assistant message with cost and actions

```tsx
import {
  ChatMessage,
  ChatMessageCopyAction,
  ChatMessageForkAction,
} from '@/components/chat-message';

<ChatMessage
  message="Here is the answer to your question…"
  sentAt={responseDate}
  duration={1420}
  cost={{ tokensPerSecond: 14.2, dollars: 0.0018 }}
  showBG
  actions={
    <>
      <ChatMessageCopyAction content={rawText} />
      <ChatMessageForkAction onFork={handleFork} />
    </>
  }
/>
```

### User message (mirrored)

```tsx
<ChatMessage
  message="What is the capital of France?"
  sentAt={new Date()}
  mirrored
  showBG
  actions={<ChatMessageCopyAction content="What is the capital of France?" />}
/>
```

---

## Action components

All three action components render an `<ActionButton>` — a small icon button with muted color and 50 % opacity that fades to full opacity on hover.

### `ChatMessageCopyAction`

Copies `content` to the clipboard when clicked.

```tsx
<ChatMessageCopyAction content={message} />
```

| Prop | Type | Description |
|---|---|---|
| `content` | `string` | Text written to the clipboard. |

### `ChatMessageForkAction`

Calls `onFork` when clicked. Renders a `GitFork` icon. Falls back to a no-op if `onFork` is omitted.

```tsx
<ChatMessageForkAction onFork={() => createFork(threadId)} />
```

| Prop | Type | Description |
|---|---|---|
| `onFork` | `() => void` | Optional. Called on click. |

### `ChatMessageSaveAction`

Saves `content` as a Markdown file. Uses the File System Access API (`showSaveFilePicker`) when available, falling back to an anchor-download in browsers that do not support it.

```tsx
<ChatMessageSaveAction content={message} filename="response.md" />
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `content` | `string` | — | Text written to the file. |
| `filename` | `string` | `"message.md"` | Suggested file name shown in the save dialog. |
