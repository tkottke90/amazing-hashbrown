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
const HOST_STYLE = ':host svg { max-width: 100%; height: auto; }';

class MarkdownSvgSandboxElement extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = HOST_STYLE;
    root.appendChild(style);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get(TAG_NAME)) {
  customElements.define(TAG_NAME, MarkdownSvgSandboxElement);
}

export interface SvgSandboxProps {
  children?: ComponentChildren;
}

export function SvgSandbox({ children }: SvgSandboxProps) {
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
      ref={(el: MarkdownSvgSandboxElement | null) => {
        hostRef.current = el;
      }}
    >
      {shadowRoot ? compat.createPortal(children, shadowRoot) : null}
    </markdown-svg-sandbox>
  );
}
