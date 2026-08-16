# AGENTS.md — ui/src/components

Component-level conventions for the Preact frontend. See `ui/AGENTS.md` for
project-wide layout, styling, and command reference.

This folder holds components reused across 2+ pages. Page-specific
components follow the same conventions below but live under
`src/pages/<name>/` instead — see `ui/AGENTS.md`'s "Where does this file
go?" section.

## Dialogs

Dialogs use the `Modal` component from `@tkottke90/preact-dialog` (the
workspace package in `lib/preact-dialog`). `Modal` wraps `Dialog` — the
package's structural base, which wraps the native `<dialog>` element and
follows a trigger-as-prop pattern, but carries no positioning/animation
styling of its own — with the centered, fade-in look most dialogs in this
app want. (The package also ships `Drawer` and `BottomSheet` for
edge-docked/slide-up variants; reach for `Dialog` directly only when
building a new overlay style.) Existing examples: `NewDomainModal`
(`wiki/new-domain-form.tsx`) and `UploadWikiDialog`
(`wiki/upload-wiki-form.tsx`).

### The pattern

Split every dialog into two components:

1. **A dialog wrapper** (`<Name>Dialog` / `<Name>Modal`) — renders `<Modal>`
   with the trigger element and the content component as a child.
2. **A content/form component** — rendered inside `<Modal>`, so it can call
   `useDialog()` to access the dialog context (most importantly `close()`).

```tsx
import { Modal, useDialog } from '@tkottke90/preact-dialog';

export function ExampleDialog() {
  return (
    <Modal
      title="Example"
      trigger={
        <button type="button" title="Open example">
          Open
        </button>
      }
    >
      <ExampleForm />
    </Modal>
  );
}

function ExampleForm() {
  const { close } = useDialog();

  function handleSubmit(e: Event) {
    e.preventDefault();
    // ... do work, reset local state ...
    close();
  }

  return <form onSubmit={handleSubmit}>{/* ... */}</form>;
}
```

### Rules

- The trigger goes in the `trigger` prop, **not** as a sibling of `<Modal>`.
  `Dialog` (which `Modal` wraps) clones the element and attaches the click
  listener that opens the modal itself — do not add your own
  `onClick`/open-state signal to the trigger.
- `useDialog()` only works in components rendered as children of `<Modal>`.
  That is why the content lives in its own component instead of inline in the
  wrapper: the wrapper renders the provider, the child consumes it.
- Close the dialog with `close()` from `useDialog()` (Cancel buttons, after a
  successful submit, etc.). Reset any local form state before calling it —
  dialog children stay mounted while the dialog is hidden, so state persists
  across open/close otherwise.
- The dialog's built-in X button calls `onCancel`, not `onClose` — `onClose`
  only fires via `useDialog().close()`. Put cleanup that must run on every
  dismissal path on `onCancel` (or on both).
- `title` sets the dialog heading; `className` extends the dialog panel's
  styles (e.g. width/margin overrides — see `NewDomainModal`).
