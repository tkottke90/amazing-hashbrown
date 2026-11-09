---
status: accepted
---

# Mobile zoom-safe sizing patches native `<select>`s in place instead of migrating them to the `Select` primitive

Issue #397's fix needs every raw native form control that renders under 16px
to stop triggering iOS Safari's focus-zoom. For `<input>`/`<textarea>` this
means migrating call sites to the shared `Input`/`Textarea` primitives
(`ui/src/components/ui/{input,textarea}.tsx`), which are drop-in wrappers
around the same native element with `text-base md:text-sm` already baked in.
The shared `Select` (`ui/src/components/ui/select.tsx`) is not that: it's a
Radix-based custom dropdown with different markup and `onValueChange`/
string-value binding, versus a native `<select>`'s `onChange`/
`e.target.value`. Migrating every raw `<select>` call site to it would mean
rewriting each site's state wiring, not just its classes — out of proportion
to a font-size bug. We instead apply the same `text-base md:text-sm` classes
directly to the raw `<select>` elements and leave their native markup and
event handling untouched. The asymmetry (`Input`/`Textarea` migrate,
`Select` doesn't) is deliberate: a future contributor fixing another raw
`<select>` for the same reason should default to the same className patch,
not assume it needs the `Select` primitive.
