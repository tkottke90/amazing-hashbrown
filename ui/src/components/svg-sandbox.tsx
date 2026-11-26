import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import compat from 'preact/compat';

// The SVG Sandbox (ADR-0072, GLOSSARY.md "Markdown Rendering & Inline SVG").
// Every rendered inline SVG is mounted inside this custom element's open
// Shadow DOM — not directly into the page — so a schema-allowed `<style>`
// (see markdown-sanitize-schema.ts) is genuinely CSS-scoped to this SVG
// alone, and so an `id` the schema no longer clobber-prefixes can't shadow
// the app's real `window`/`document` globals.
const TAG_NAME = 'markdown-svg-sandbox';

// Reproduces the responsive-sizing rule the normal Tailwind/`prose` cascade
// can no longer reach once content is shadow-scoped — trusted,
// developer-authored CSS, unrelated to the Markdown Sanitize Schema.
const FLOW_HOST_STYLE = ':host svg { max-width: 100%; height: auto; }';

// An SVG Widget's card gives the drawing a fixed box rather than text flow:
// the SVG fills it and the default `preserveAspectRatio` (meet) scales and
// centers the drawing inside, never overflowing or scrolling.
const CARD_HOST_STYLE =
  ':host { display: block; width: 100%; height: 100%; } ' +
  ':host svg { display: block; width: 100%; height: 100%; }';

/**
 * `flow`: Markdown's inline-in-prose sizing (the default).
 * `card`: fit the enclosing box — used by the SVG Widget.
 */
export type SvgSandboxFit = 'flow' | 'card';

export class MarkdownSvgSandboxElement extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    // Read once at connection: Preact applies props before inserting the
    // element, so `data-fit` is already set by now.
    style.textContent = this.dataset['fit'] === 'card' ? CARD_HOST_STYLE : FLOW_HOST_STYLE;
    root.appendChild(style);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get(TAG_NAME)) {
  customElements.define(TAG_NAME, MarkdownSvgSandboxElement);
}

export interface SvgSandboxProps {
  children?: ComponentChildren;
  /** Fixed for the sandbox's lifetime — the host stylesheet is built once. */
  fit?: SvgSandboxFit;
}

export function SvgSandbox({ children, fit = 'flow' }: SvgSandboxProps) {
  const hostRef = useRef<MarkdownSvgSandboxElement | null>(null);
  // The ref callback fires during commit, before this component's own next
  // render — forcing one extra render is what lets the portal below read a
  // `shadowRoot` that now actually exists on first paint.
  const [, forceRender] = useState(0);

  useEffect(() => {
    forceRender((n) => n + 1);
  }, []);

  const shadowRoot = hostRef.current?.shadowRoot ?? null;

  return (
    <markdown-svg-sandbox
      data-testid="svg-sandbox"
      data-fit={fit}
      ref={(el: MarkdownSvgSandboxElement | null) => {
        hostRef.current = el;
      }}
    >
      {shadowRoot ? compat.createPortal(children, shadowRoot) : null}
    </markdown-svg-sandbox>
  );
}
