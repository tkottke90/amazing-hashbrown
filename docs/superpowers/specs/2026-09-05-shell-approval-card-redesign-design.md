# Shell approval card redesign

Issue: [tkottke90/amazing-hashbrown#133](https://github.com/tkottke90/amazing-hashbrown/issues/133)

## Problem

The `shell_approval` HITL card in the chat window dumps the raw, unformatted
`shell_exec` command into the card body (`hitl-prompt-message.tsx`'s
`shell_approval` branch). This is unreadable (no syntax highlighting,
heredoc/multi-command scripts run together as a wall of text) and can blow
out the chat layout: the `<pre>` has `overflow-hidden` but no height cap, so
`overflow-hidden` doesn't stop the element itself from growing arbitrarily
tall for a long or multi-line command. The agent-supplied `reason` — the
part a user actually needs to make an approve/deny decision — is rendered
second, small, and muted.

Correction to the issue's premise: the issue states a `Dialog` component
already exists at `ui/src/components/ui/dialog.tsx`. It does not. The only
related primitive is `sheet.tsx`, a slide-in drawer built on the same Radix
`Dialog` primitive. This design adds a real centered `Dialog` component.

## Goals

- `reason` becomes the card's primary, prominent content.
- The raw command is never inlined into the card. It's available on demand
  via a "View command" action.
- The card's own markup can never grow taller than a fixed number of lines
  regardless of command length — the overflow bug becomes structurally
  impossible, not just visually mitigated.
- The full-command viewer scrolls internally and never affects the
  surrounding chat layout, no matter how long the command is.

## Backend: make `reason` required on `shell_exec`

`api/src/agents/tools/shell-exec.tool.ts`'s `ShellExecSchema.reason` drops
`.optional()` and gains `.min(1, ...)`, so an empty string doesn't satisfy
"required" in practice:

```ts
reason: z
  .string()
  .min(1, 'reason is required')
  .describe('Explain why this command is needed (shown to user if approval is required)'),
```

This only changes the Zod schema the LLM's tool-calling API validates
against. It does **not** touch:

- `ApprovalCallback` / `ShellExecutor` in `lib/shell-executor` — `reason`
  stays optional there (`(command: string, reason?: string) => ...`).
  `lib/skills-manager`'s runner (`runJsScript`/`runPythonScript` via
  `runner.ts`) calls `executor.execute(command)` with no reason at all for
  its own internal, non-agent-driven use, and that's a legitimate,
  unrelated call site.
- `HitlPromptFields.reason` (`thread-message-writer.ts`) and the persisted
  `HitlThreadMessage.reason` / UI type (`thread-message.ts`) — these stay
  optional. Thread rows written before this change won't have a `reason`,
  so the UI must keep a fallback for that case (see below).

`system-prompt.ts`'s `SHELL_EXECUTION_SECTION` already instructs the model
to "always fill in the reason field" — no wording change needed; this just
backs that guidance with enforcement.

## UI: approval card redesign

`ui/src/components/hitl-prompt-message.tsx`, `shell_approval` branch is
restructured to:

1. **Reason, prominent, first**: `text-sm text-foreground` (not muted),
   directly under the question header. Fallback for legacy rows without one:
   `"No reason was provided for this command."`
2. **One-line command preview + "View command" button**, in a flex row:
   - Preview text is `message.command.split('\n')[0]`, rendered
     `font-mono text-xs truncate` inside a `min-w-0 flex-1` container.
     CSS `truncate` (ellipsis) caps it to exactly one line regardless of
     how long that first line is — no JS truncation logic needed.
   - A "View command" button (only rendered when `message.command` is set)
     opens the new `Dialog` with the full raw command.
3. Deny / Approve & remember / Approve buttons: unchanged, same row.

Nothing in the card's own markup can grow past a fixed height based on
command content — the overflow bug is closed structurally.

## New `Dialog` component

`ui/src/components/ui/dialog.tsx`, modeled directly on `sheet.tsx`:

- Same `Dialog` primitive from `radix-ui`, same `forwardRef` pattern
  (preserving the comment on why — Preact/compat's `Presence` internals
  need real refs, not plain function components), same conventions
  (`data-slot`, `cn()`, `data-open`/`data-closed` animation classes).
- Positioning differs from Sheet: centered modal
  (`fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl`)
  instead of edge-anchored slide-in.
- Exports mirror Sheet's naming: `Dialog`, `DialogTrigger`, `DialogClose`,
  `DialogPortal`, `DialogOverlay`, `DialogContent`, `DialogHeader`,
  `DialogFooter`, `DialogTitle`, `DialogDescription`.
- **`DialogContent` caps at `max-h-[85vh]`, with the body region set to
  `overflow-y-auto`.** This is the actual fix for the layout-blowout bug:
  no matter how long the command, the dialog scrolls internally and the
  page/chat layout is never affected.

## Command viewer content

Inside `DialogContent`, the full command is rendered by wrapping it in a
fenced code block and passing it through the existing `Markdown` component:

```tsx
<Markdown>{`\`\`\`bash\n${message.command}\n\`\`\``}</Markdown>
```

This reuses `Markdown`'s existing `CodeBlock` (highlight.js syntax
highlighting, hover-activated copy button) instead of building a bespoke
code viewer.

Known, accepted limitation: a command containing a literal run of 3+
backticks could break the Markdown fence. Vanishingly rare for shell
commands; not worth engineering around for v1.

## Testing

This codebase has no UI unit tests (`ui/src` is Playwright e2e only) and no
existing tests for `shell-exec.tool.ts`.

- Extend `e2e/tests/hitl-shell-approval.spec.ts` with a step asserting: the
  reason text is visible and prominent, the command preview shows only the
  first line, and clicking "View command" opens the dialog with the full
  multi-line command visible.
- Add a Mocha unit test for `ShellExecSchema` confirming a tool call
  omitting (or empty-stringing) `reason` fails validation.

## Out of scope

- Changing `ApprovalCallback`/`ShellExecutor` library-level typing.
- A truncated inline preview beyond the single first line (no "show 3
  lines then fade" or similar — one line, CSS ellipsis, done).
- Shell-specific syntax highlighting beyond what `rehype-highlight`'s
  `bash` grammar already provides.
