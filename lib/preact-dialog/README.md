# @tkottke90/preact-dialog

A thin Preact wrapper around the browser's native `<dialog>` element. Pairs a trigger element with a modal, manages open/close lifecycle via DOM refs, and exposes context so deeply nested children can close the dialog without prop drilling.

## Installation

This package is private to the monorepo. It is consumed via the npm workspace alias:

```json
"@tkottke90/preact-dialog": "*"
```

### Peer dependencies

| Package           | Version                                |
| ----------------- | -------------------------------------- |
| `preact`          | `>=10.0.0`                             |
| `@preact/signals` | `>=1.0.0`                              |
| `lucide-preact`   | any (used for the built-in close icon) |

## Quick start

```tsx
import { Dialog } from '@tkottke90/preact-dialog';

export function MyFeature() {
  return (
    <Dialog trigger={<button>Open settings</button>} title="Settings">
      <p>Dialog content goes here.</p>
    </Dialog>
  );
}
```

The `trigger` element is cloned with a `click` listener attached. Clicking it calls `showModal()` on the underlying `<dialog>` element.

## API

### `<Dialog>`

```tsx
<Dialog
  trigger={<button>Open</button>}
  title="My Dialog"
  onOpen={() => console.log('opened')}
  onClose={() => console.log('closed')}
  onCancel={() => console.log('cancelled (Escape)')}
  disableClose={false}
  className="extra-tailwind-classes"
>
  {/* children */}
</Dialog>
```

| Prop           | Type                    | Default                 | Description                                                                            |
| -------------- | ----------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `children`     | `ComponentChildren`     | —                       | Content rendered inside the dialog panel.                                              |
| `trigger`      | `JSX.Element`           | `<button>Open</button>` | Element that opens the dialog on click. Receives a `ref` via `cloneElement`.           |
| `title`        | `string \| JSX.Element` | —                       | Rendered in the dialog header alongside the close button.                              |
| `disableClose` | `boolean`               | `false`                 | Hides the built-in ✕ close button when `true`.                                         |
| `className`    | `string`                | —                       | Extra CSS classes appended to the `<dialog>` element.                                  |
| `onOpen`       | `() => void`            | —                       | Called just before `showModal()`.                                                      |
| `onClose`      | `() => void`            | —                       | Called when the dialog closes via the ✕ button or `useDialog().close()`.               |
| `onCancel`     | `() => void`            | —                       | Called when the dialog is dismissed via the ✕ button's cancel path or `cancelModal()`. |

> **Note:** `DialogProps` includes an `open?: Signal<boolean>` field, but the current implementation does not read it. Control the dialog through the `trigger` prop or `useDialog()` instead.

#### Styling

The `<dialog>` element ships with Tailwind utility classes. It uses:

- Dark-mode variants (`dark:bg-neutral-700/80`, `dark:text-neutral-200`)
- The `open:` and `starting:open:` variants for CSS `@starting-style` entry animations (fade + slide)
- `backdrop:` variants for the dimmed backdrop

A minimum width of `min-w-10/12` is applied on mobile and `sm:min-w-150` on small screens and above.

---

### `useDialog()`

Access the dialog's context from any descendant component:

```tsx
import { useDialog } from '@tkottke90/preact-dialog';

function SaveButton() {
  const { close } = useDialog();

  function handleSave() {
    // ... save logic
    close('saved'); // native dialog returnValue is set to 'saved'
  }

  return <button onClick={handleSave}>Save</button>;
}
```

| Property | Type                        | Description                                                                            |
| -------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `dialog` | `HTMLDialogElement \| null` | The underlying `<dialog>` DOM node.                                                    |
| `close`  | `(value?: string) => void`  | Calls `onClose` then closes the dialog; `value` becomes the dialog's `returnValue`.    |
| `value`  | `string \| undefined`       | The value passed to the last `close()` call (mirrors `HTMLDialogElement.returnValue`). |

---

### Helper functions

These are exported for cases where you need to drive a dialog imperatively from outside the component tree.

#### `openModal(modal, onOpen?)`

```ts
openModal(dialogRef.current, () => console.log('opened'));
```

Calls `showModal()` on the provided `HTMLDialogElement`. Invokes `onOpen` first if supplied.

#### `closeModal(modal, value?)`

```ts
closeModal(dialogRef.current, 'confirmed');
```

Calls `close(value)` on the provided element.

#### `cancelModal(modal, onCancel?)`

```ts
cancelModal(dialogRef.current, () => console.log('cancelled'));
```

Invokes `onCancel` then calls `closeModal`. Intended for Escape-key or explicit cancel paths.

---

### `usePortal(selector)`

Creates a portal attached to a DOM node matching `selector`. Falls back to `document.body` with a console warning if the selector yields no match.

```tsx
import { usePortal } from '@tkottke90/preact-dialog';

function Overlay() {
  const portal = usePortal('#modal-root');
  return portal(<div>Rendered outside the component tree</div>);
}
```

---

### `useHtmlElementListeners(events, inputs?)`

Returns a callback ref that registers multiple DOM event listeners on a node and cleans them up on unmount.

```tsx
import { useHtmlElementListeners } from '@tkottke90/preact-dialog';

function MyButton() {
  const ref = useHtmlElementListeners(
    [
      ['click', (e) => console.log('clicked', e)],
      ['keydown', (e) => console.log('key', e)],
    ],
    [], // dependency inputs (same semantics as useCallback)
  );

  return <button ref={ref}>Click me</button>;
}
```

---

### `registerEvent(element, eventName, event)`

Low-level helper that calls `addEventListener` and returns an unsubscribe function.

```ts
import { registerEvent } from '@tkottke90/preact-dialog';

const unsubscribe = registerEvent(buttonEl, 'click', handler);
// later:
unsubscribe();
```

---

## Build

```bash
npm run build --workspace lib/preact-dialog
# or in watch mode:
npm run dev --workspace lib/preact-dialog
```

Output is emitted to `dist/` as ESM `.js` files with co-located `.d.ts` declarations.
