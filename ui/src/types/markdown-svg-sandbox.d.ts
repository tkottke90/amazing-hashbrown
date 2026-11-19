// Ambient JSX typing for the `<markdown-svg-sandbox>` custom element
// svg-sandbox.tsx defines and renders — not a known Preact JSX intrinsic
// otherwise. Scoped here rather than inline in svg-sandbox.tsx to match
// this project's existing ambient-declaration convention (see
// file-system-access.d.ts). Augments the same global `preact.JSX` namespace
// markdown.tsx's own component props already reference directly
// (`preact.JSX.HTMLAttributes<...>`) with no import needed.

declare namespace preact.JSX {
  interface IntrinsicElements {
    'markdown-svg-sandbox': preact.JSX.HTMLAttributes<HTMLElement>;
  }
}
