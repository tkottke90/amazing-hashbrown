# Design System

**Date:** 2026-08-06
**Status:** Living Document
**Source of truth:** [`ui/src/style.css`](../../ui/src/style.css)

---

## Overview

The UI is built on **Preact 10 + Tailwind CSS v4** with **shadcn/ui** (Radix Nova style) component primitives. Tailwind v4 has no external config file — all design tokens are defined inline in `ui/src/style.css` via `@theme` and CSS custom properties. Dark mode is class-based (`.dark` on `<html>`), not media-query-based.

---

## Color

### Brand Palette

Two custom color scales replace Tailwind's defaults and serve as the semantic token source.

#### Blue (Primary)

| Token      | Hex       |
| ---------- | --------- |
| `blue-50`  | `#f3f2ff` |
| `blue-100` | `#e9e7ff` |
| `blue-200` | `#d4d2ff` |
| `blue-300` | `#b4adff` |
| `blue-400` | `#907fff` |
| `blue-500` | `#6c4bff` |
| `blue-600` | `#5c26ff` |
| `blue-700` | `#4f15ec` |
| `blue-800` | `#4712d7` |
| `blue-900` | `#3810a2` |
| `blue-950` | `#1f076e` |

#### Night Shadz (Destructive / Error)

| Token             | Hex       |
| ----------------- | --------- |
| `night-shadz-50`  | `#fdf2f7` |
| `night-shadz-100` | `#fce7f2` |
| `night-shadz-200` | `#fbcfe5` |
| `night-shadz-300` | `#faa7cf` |
| `night-shadz-400` | `#f571ae` |
| `night-shadz-500` | `#ed478f` |
| `night-shadz-600` | `#dc266c` |
| `night-shadz-700` | `#ba1650` |
| `night-shadz-800` | `#9e1644` |
| `night-shadz-900` | `#84173c` |
| `night-shadz-950` | `#51061f` |

---

### Semantic Tokens

Semantic tokens are CSS custom properties that map brand scale values to UI roles. Components should reference semantic tokens, not raw brand-scale values.

| Token                    | Light                         | Dark                                    |
| ------------------------ | ----------------------------- | --------------------------------------- |
| `--background`           | `oklch(1 0 0)` — pure white   | `oklch(0.145 0 0)` — near-black         |
| `--foreground`           | `oklch(0.145 0 0)`            | `oklch(0.985 0 0)`                      |
| `--card`                 | `oklch(1 0 0)`                | `oklch(0.205 0 0)`                      |
| `--card-foreground`      | `oklch(0.145 0 0)`            | `oklch(0.985 0 0)`                      |
| `--popover`              | `oklch(1 0 0)`                | `oklch(0.205 0 0)`                      |
| `--popover-foreground`   | `oklch(0.145 0 0)`            | `oklch(0.985 0 0)`                      |
| `--primary`              | `blue-600` — `#5c26ff`        | `blue-400` — `#907fff`                  |
| `--primary-foreground`   | `blue-50` — `#f3f2ff`         | `blue-950` — `#1f076e`                  |
| `--secondary`            | `oklch(0.97 0 0)`             | `oklch(0.269 0 0)`                      |
| `--secondary-foreground` | `oklch(0.205 0 0)`            | `oklch(0.985 0 0)`                      |
| `--muted`                | `oklch(0.97 0 0)`             | `oklch(0.269 0 0)`                      |
| `--muted-foreground`     | `oklch(0.556 0 0)`            | `oklch(0.708 0 0)`                      |
| `--accent`               | `oklch(0.97 0 0)`             | `oklch(0.269 0 0)`                      |
| `--accent-foreground`    | `oklch(0.205 0 0)`            | `oklch(0.985 0 0)`                      |
| `--destructive`          | `night-shadz-600` — `#dc266c` | `night-shadz-400` — `#f571ae`           |
| `--success`              | `oklch(0.6 0.14 155)` — green | `oklch(0.72 0.15 155)` — brighter green |
| `--border`               | `oklch(0.922 0 0)`            | `oklch(1 0 0 / 10%)`                    |
| `--input`                | `oklch(0.922 0 0)`            | `oklch(1 0 0 / 15%)`                    |
| `--ring`                 | `blue-400` — `#907fff`        | `blue-500` — `#6c4bff`                  |

#### Sidebar Tokens

The sidebar has its own semantic layer so its surface can differ from the main canvas independently.

| Token                          | Light              | Dark                 |
| ------------------------------ | ------------------ | -------------------- |
| `--sidebar`                    | `oklch(0.985 0 0)` | `oklch(0.205 0 0)`   |
| `--sidebar-foreground`         | `oklch(0.145 0 0)` | `oklch(0.985 0 0)`   |
| `--sidebar-primary`            | `blue-600`         | `blue-400`           |
| `--sidebar-primary-foreground` | `blue-50`          | `blue-950`           |
| `--sidebar-accent`             | `oklch(0.97 0 0)`  | `oklch(0.269 0 0)`   |
| `--sidebar-accent-foreground`  | `oklch(0.205 0 0)` | `oklch(0.985 0 0)`   |
| `--sidebar-border`             | `oklch(0.922 0 0)` | `oklch(1 0 0 / 10%)` |
| `--sidebar-ring`               | `blue-400`         | `blue-500`           |

#### Chart Colors

Used for data visualizations. The same five-stop grayscale scale is shared across both modes.

| Token       | Value              |
| ----------- | ------------------ |
| `--chart-1` | `oklch(0.87 0 0)`  |
| `--chart-2` | `oklch(0.556 0 0)` |
| `--chart-3` | `oklch(0.439 0 0)` |
| `--chart-4` | `oklch(0.371 0 0)` |
| `--chart-5` | `oklch(0.269 0 0)` |

The wiki domain graph uses a separate fixed-hue palette for categorical node coloring:

```
#6366f1  indigo
#f59e0b  amber
#10b981  emerald
#ef4444  red
#8b5cf6  violet
#06b6d4  cyan
```

#### Tool Call Status Colors

| Status      | Light                            | Dark                             |
| ----------- | -------------------------------- | -------------------------------- |
| Pending     | `bg-amber-100 text-amber-700`    | `bg-amber-900/30 text-amber-400` |
| Done        | `bg-green-100 text-green-700`    | `bg-green-900/30 text-green-400` |
| Interrupted | `bg-muted text-muted-foreground` | same                             |

#### Code Block Syntax Highlighting

Powered by highlight.js with the GitHub theme.

|       | Background | Foreground      |
| ----- | ---------- | --------------- |
| Light | `#f6f8fa`  | (theme default) |
| Dark  | `#0d1117`  | `#c9d1d9`       |

---

### Dark Mode

Dark mode is toggled by adding the `.dark` class to `<html>`. The `ThemeProvider` (`ui/src/hooks/use-theme.tsx`) persists the preference in `localStorage` under the key `hashbrown-theme` with values `'light'` | `'dark'` | `'system'`. System mode listens to `(prefers-color-scheme: dark)`.

The Tailwind v4 variant is defined as:

```css
@custom-variant dark (&:is(.dark *));
```

---

## Typography

### Font Family

| Role                 | Value                          |
| -------------------- | ------------------------------ |
| `--font-sans` (body) | `'Geist Variable', sans-serif` |
| `--font-heading`     | aliased to `var(--font-sans)`  |
| `--font-mono`        | Tailwind system mono stack     |

**Geist Variable** is loaded via `@fontsource-variable/geist`. There is a single variable-weight axis, so all weights come from one file with no separate font-face declarations needed.

The base font size on `<html>` is `16px`. All rem values below are relative to this base.

### Font Sizes

| Tailwind class | rem      | px    | Typical usage                                    |
| -------------- | -------- | ----- | ------------------------------------------------ |
| `text-xs`      | 0.75rem  | 12px  | Meta labels, timestamps, chips, code copy button |
| `text-sm`      | 0.875rem | 14px  | Primary body text for most UI elements           |
| `text-base`    | 1rem     | 16px  | Inputs, textareas                                |
| `text-lg`      | 1.125rem | 18px  | Section headings within panels                   |
| `text-xl`+     | ≥1.25rem | ≥20px | Page-level headings                              |

### Font Weights

| Class                     | Usage                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| `font-medium`             | Card titles, sheet titles, navigation items, default button text |
| `font-semibold`           | Active thread rows, code block language labels                   |
| `font-mono font-semibold` | Tool call name display                                           |

### Prose (Markdown)

Markdown content uses the `@tailwindcss/typography` plugin via:

```
prose prose-sm dark:prose-invert max-w-none
```

The prose `pre` reset lets highlight.js control code block chrome:

```css
.prose pre {
  background: transparent;
  padding: 0;
  color: inherit;
}
```

Maximum message bubble width is capped at `max-w-[min(80%,75ch)]`.

---

## Spacing & Layout

These are not exhaustive but document the key structural values.

| Element                        | Value             |
| ------------------------------ | ----------------- |
| Base radius token (`--radius`) | `0.625rem` (10px) |
| Sidebar width                  | `w-64` (256px)    |
| Mobile bottom nav height       | `h-20` (80px)     |
| Max message bubble width       | `min(80%, 75ch)`  |

---

## Border Radius

The `--radius` base is `0.625rem`. All other steps are computed from it:

| Token          | Formula               | Approx. px |
| -------------- | --------------------- | ---------- |
| `--radius-sm`  | `var(--radius) * 0.6` | ~6px       |
| `--radius-md`  | `var(--radius) * 0.8` | ~8px       |
| `--radius-lg`  | `var(--radius)`       | 10px       |
| `--radius-xl`  | `var(--radius) * 1.4` | ~14px      |
| `--radius-2xl` | `var(--radius) * 1.8` | ~18px      |
| `--radius-3xl` | `var(--radius) * 2.2` | ~22px      |
| `--radius-4xl` | `var(--radius) * 2.6` | ~26px      |

### Applied Radius by Component

| Component                    | Class                                  |
| ---------------------------- | -------------------------------------- |
| Button (xs, icon-xs)         | `rounded-[min(var(--radius-md),10px)]` |
| Button (sm, icon-sm)         | `rounded-[min(var(--radius-md),12px)]` |
| Button (default, lg, icon)   | `rounded-lg`                           |
| Checkbox                     | `rounded-[4px]`                        |
| Switch track                 | `rounded-full`                         |
| Badge, pill                  | `rounded-full`                         |
| Chat input container         | `rounded-[4px]`                        |
| Main content panel (desktop) | `rounded-l-2xl`                        |
| Cards                        | `rounded-lg`                           |

---

## Elevation & Shadow

| Usage                                    | Value                                       |
| ---------------------------------------- | ------------------------------------------- |
| Dropdown menus, popovers, select content | `shadow-md` + `ring-1 ring-foreground/10`   |
| Sheet / drawer panel                     | `shadow-lg`                                 |
| Cards                                    | `ring-1 ring-foreground/10` (no shadow)     |
| HITL prompt card                         | `shadow-sm` + border                        |
| FAB new conversation button              | `shadow-lg`                                 |
| Main content panel left edge             | `shadow-[-8px_0_24px_-6px_rgb(0_0_0/0.15)]` |

---

## Component State Behaviors

### Hover

| Variant                 | Hover style                                                            |
| ----------------------- | ---------------------------------------------------------------------- |
| Button — default        | `hover:bg-primary/80`                                                  |
| Button — outline        | `hover:bg-muted hover:text-foreground`                                 |
| Button — ghost          | `hover:bg-muted hover:text-foreground` (dark: `hover:bg-muted/50`)     |
| Button — secondary      | `hover:bg-[color-mix(in oklch,var(--secondary),var(--foreground)_5%)]` |
| Button — destructive    | `hover:bg-destructive/20` (dark: `hover:bg-destructive/30`)            |
| Button — link           | `hover:underline`                                                      |
| Thread / nav rows       | `hover:bg-sidebar-accent`                                              |
| Icon action buttons     | `hover:bg-muted hover:opacity-100` (from `opacity-50`)                 |
| Dropdown / menu items   | `focus:bg-accent focus:text-accent-foreground`                         |
| Tool call expand button | `hover:bg-muted/30 transition-colors`                                  |
| HITL choices            | `hover:bg-accent`                                                      |
| Select trigger (dark)   | `dark:hover:bg-input/50`                                               |

### Focus

All interactive elements use a consistent ring pattern:

```css
focus-visible:border-ring
focus-visible:ring-3
focus-visible:ring-ring/50
```

The global base layer sets a default outline on all elements:

```css
* {
  @apply border-border outline-ring/50;
}
```

Invalid / error state overlays the ring with destructive color:

```css
aria-invalid:border-destructive
aria-invalid:ring-3
aria-invalid:ring-destructive/20
/* dark */
dark:aria-invalid:border-destructive/50
dark:aria-invalid:ring-destructive/40
```

### Disabled

```css
disabled:pointer-events-none
disabled:opacity-50
/* inputs and textareas also get: */
disabled:cursor-not-allowed
disabled:bg-input/50
dark:disabled:bg-input/80
```

Radix-based components (e.g. Switch) use the data attribute equivalent:

```css
data-disabled:cursor-not-allowed
data-disabled:opacity-50
```

### Active / Pressed

Buttons nudge down 1px on press, except when they're a popup trigger:

```css
active:not-aria-[haspopup]:translate-y-px
```

### Expanded (aria-expanded)

| Variant                  | Expanded style                                         |
| ------------------------ | ------------------------------------------------------ |
| Button — outline / ghost | `aria-expanded:bg-muted aria-expanded:text-foreground` |
| Button — secondary       | `aria-expanded:bg-secondary`                           |

### Open / Closed (Radix state)

Overlay panels and menus animate in and out using `tw-animate-css`:

```css
/* Open */
data-open:animate-in
data-open:fade-in-0
data-open:zoom-in-95

/* Closed */
data-closed:animate-out
data-closed:fade-out-0
data-closed:zoom-out-95
```

Sheets slide from their respective edge:

```css
data-open: slide-in-from-[side]-10; /* side = left | right | top | bottom */
```

Animation duration for overlays is `duration-100` (100ms).

---

## Motion & Transitions

| Class                        | Usage                                                       |
| ---------------------------- | ----------------------------------------------------------- |
| `transition-colors`          | Inputs, buttons, nav links, dropdown items                  |
| `transition-all`             | Buttons (global), Switch thumb                              |
| `transition-opacity`         | Action buttons, dropdown menu trigger icon                  |
| `animate-bounce`             | Loading indicator — 3 dots with 0ms / 150ms / 300ms stagger |
| `animate-spin`               | `Loader2` icon, graph refresh indicator                     |
| `animate-in` / `animate-out` | Radix popover, dropdown, and sheet open/close               |

---

## Settings Page With Sub-Navigation

Every Settings nav entry maps to exactly one flat panel — this was true for every page until the Workspaces / Trackers page (2026-08-20, see `docs/superpowers/specs/2026-08-20-workspaces-trackers-settings-design.md`), the first to need more than one grouped sub-view under one nav entry.

**When to use it:** a settings area has genuinely separable sub-topics (not just long — a long single-topic panel stays flat), and at least one of them is itself substantial (a list + modal, not a couple of fields). Don't reach for this to avoid a slightly long panel; reach for it when "General" and "Trackers" wouldn't make sense as the same page.

**Shape:** a thin shell component owns a local `activeSubsection` signal (not URL state — the existing `?section=` query param stays at the nav-entry granularity) defaulting to the first/only sub-section, rendered as a small horizontal pill row using the same visual language as the left `SettingsNav` buttons, sized down: `rounded-full px-3 py-1.5 text-sm`, inactive `text-muted-foreground hover:bg-muted hover:text-foreground`, active `bg-primary/10 text-primary font-medium` (the same tint already used for the "Default" badge in `model-providers-panel.tsx` — reused here for an active-tab indicator rather than invented fresh). Below the pill row, the shell switches between sub-section components — plain conditional rendering, no tab library:

```tsx
const activeSubsection = useSignal<'trackers'>('trackers');
// ...
<div class="subnav-row">
  <button data-active={activeSubsection.value === 'trackers'}>Trackers</button>
</div>
{activeSubsection.value === 'trackers' && <TrackersSection />}
```

Each sub-section component is a normal panel otherwise — same `useSettingsSection`, `SaveDiscardBar`, `FieldError` as any flat panel; the sub-nav only decides which one is mounted. Adding a second sub-section is additive: one more pill button, one more conditional branch, no restructuring of the shell or its state model.

## Source Reference

| File                                 | Role                                     |
| ------------------------------------ | ---------------------------------------- |
| `ui/src/style.css`                   | Design tokens, Tailwind entry, dark mode |
| `ui/src/components/ui/button.tsx`    | Button variant and size matrix           |
| `ui/src/components/ui/input.tsx`     | Input field base styles                  |
| `ui/src/hooks/use-theme.tsx`         | Dark mode provider                       |
| `ui/src/components/theme-toggle.tsx` | Dark mode toggle component               |
