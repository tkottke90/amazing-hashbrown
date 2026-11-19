// Ambient JSX typing for the `<markdown-svg-sandbox>` custom element
// svg-sandbox.tsx defines and renders — not a known Preact JSX intrinsic
// otherwise. Scoped here rather than inline in svg-sandbox.tsx to match
// this project's existing ambient-declaration convention (see
// file-system-access.d.ts).
//
// Typed against MarkdownSvgSandboxElement itself, not a generic
// HTMLElement — the `ref` callback SvgSandbox passes only accepts
// `MarkdownSvgSandboxElement | null`, and a `Ref<HTMLElement>`-typed prop
// (what a generic HTMLAttributes<HTMLElement> would produce) requires its
// callback to accept any HTMLElement, not a narrower subtype (TS2322).
// Importing a real type here makes this a module rather than a global
// script, so the augmentation has to go through `declare global`.
import type { MarkdownSvgSandboxElement } from '@/components/svg-sandbox';

declare global {
  namespace preact.JSX {
    interface IntrinsicElements {
      'markdown-svg-sandbox': preact.JSX.HTMLAttributes<MarkdownSvgSandboxElement>;
    }
  }
}
