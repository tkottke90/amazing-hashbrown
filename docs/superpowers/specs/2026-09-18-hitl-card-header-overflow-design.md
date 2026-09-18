# HITL card header overflow

## Problem

In the workspace chat thread, a `shell_approval` HITL card can grow tall
enough that a user (especially on mobile) can't reach the Deny/Approve
action buttons without scrolling. The 2026-09-05 shell-approval-card
redesign (`docs/superpowers/specs/2026-09-05-shell-approval-card-redesign-design.md`)
already fixed the card _body_: the raw command is truncated to one line
with a "View command" modal for the full text, and never dumped inline.

The overflow persists because it comes from a different source the prior
redesign didn't touch: the card's **header**. `hitl-prompt-message.tsx`
renders `message.question` in an unclamped `<p>` above the
promptKind-specific body, for every prompt kind. For `shell_approval`,
`api/src/agents/stream-handler.ts` (~line 446) still builds that
`question` string by embedding the entire raw, potentially multi-line
command:

```ts
const question = reason
  ? `Allow command: \`${command}\`\n\nReason: ${reason}`
  : `Allow command: \`${command}\``;
```

A long command (e.g. a heredoc writing an entire file) makes this header
paragraph grow arbitrarily tall, pushing the action buttons off-screen.
This duplicates content already shown correctly further down in the card
(prominent `reason`, one-line command preview, "View command" modal) — the
header's dynamic content is redundant, not just oversized.

## Goals

- The synthetic `shell_approval` header no longer embeds the raw command.
- No `message.question` value, from any prompt kind or any thread row
  (including ones persisted before this fix), can push the action buttons
  out of reach. This is a structural cap, not a truncation that could hide
  decision-relevant text.

## Fix 1 — Backend: stop embedding the command in `question`

`api/src/agents/stream-handler.ts`, `shell_approval` branch: replace the
dynamic string with a fixed generic header. `reason` and `command` are
already passed through as their own fields on the interrupt record and
rendered properly in the card body, so nothing is lost:

```ts
const question = 'Approve command execution?';
```

`command` and `reason` continue to be recorded and streamed unchanged
(`recordHitlPrompt` call and the `hitl_prompt` SSE event both keep both
fields) — only the synthetic `question` string changes.

## Fix 2 — Frontend: structural clamp on the header, for every prompt kind

`question` is still LLM-authored free text for `yes_no`, `multiple_choice`,
and free-text prompts, and thread rows already persisted with the old
long-embedded-command format remain in history. So the header itself gets
capped, independent of which prompt kind or how the `question` string was
produced — this must hold for every kind, not just `shell_approval`.

`hitl-prompt-message.tsx`, the shared header `<p>` (currently
`className="font-medium leading-snug"`, rendered before the
promptKind-conditional body) gains a fixed max-height with internal
scrolling:

```tsx
<p className="font-medium leading-snug max-h-32 overflow-y-auto">{message.question}</p>
```

`max-h-32 overflow-y-auto` — no ellipsis/truncate, no "show more" toggle.
However long the question text is, the header scrolls internally within a
fixed ~8rem box; the full text stays reachable by scrolling _inside the
header_, and the buttons below it are always reachable without scrolling
the page. This mirrors the existing precedent in this same file (the "View
command" modal's `CodeBlock` uses the identical `overflow-y-auto` pattern)
— no new interaction pattern is introduced.

No sticky/pinned-footer mechanism is added on top of this. The overflow
source is capped at its origin (the header), so a second defensive
mechanism would be redundant complexity.

## Edge cases

- **Legacy thread rows** persisted with the old
  `` Allow command: `...` `` question format: unaffected by Fix 1 (only new
  interrupts get the static string going forward), but Fix 2's clamp bounds
  their display regardless — no data migration needed.
- **Short/empty questions**: `max-h-32 overflow-y-auto` is a no-op when
  content already fits; no visual change for the common case.

## Testing

- Update `e2e/tests/hitl-shell-approval.spec.ts` and
  `api/src/agents/thread-message-writer.test.ts` expectations that assert
  the old ``'Allow command: `ls -la`\n\nReason: ...'`` question string to
  expect `'Approve command execution?'` instead.
- Add an e2e case that triggers a `shell_approval` (or any prompt kind)
  interrupt with an intentionally long multi-line command/reason and
  asserts the Deny/Approve/Approve & remember buttons are visible in the
  viewport without scrolling the page — only the header box may scroll
  internally.

## Out of scope

- Changing the body-level command truncation/"View command" modal from
  the 2026-09-05 redesign — that part already works correctly.
- A "show more" expand/collapse toggle for the header — scrolling within a
  fixed-height box is sufficient and matches existing codebase precedent.
- Backfilling or rewriting `question` on already-persisted thread rows.
