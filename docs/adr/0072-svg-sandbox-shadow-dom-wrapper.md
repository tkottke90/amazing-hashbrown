# Every rendered inline SVG is wrapped in a Shadow-DOM-backed SVG Sandbox, not mounted directly into the page

Issue #425's Markdown Sanitize Schema (ADR-0071) needed to decide whether `<style>` could ever be allowed inside SVG. A `<style>` element mounted directly into the page's own DOM is **not** scoped to its containing SVG — its CSS selectors match the whole document, making LLM-authored or pasted chat content a page-wide UI-redress/DoS vector if `<style>` were simply schema-allowed. Rather than reject `<style>` outright, every rendered `<svg>` is instead mounted inside a dedicated custom element (the SVG Sandbox — see `GLOSSARY.md`) that attaches an open Shadow DOM and portals the SVG's already-sanitized subtree into it (`markdownComponents`'s `svg` override, via `preact/compat`'s `createPortal`) — giving `<style>` (schema-allowed only with an `ancestors: ['svg']` restriction, so it's unreachable anywhere else in a Markdown message) genuine CSS encapsulation for free.

This also resolved a second open question: Shadow DOM scopes element `id`s to the shadow root's own local namespace, so `id`/`name` were dropped from the schema's `clobber` list to let `<use href="#id">` internal references actually resolve (the default `clobberPrefix` behavior prefixes `id` but not a matching `href="#id"`, breaking the reference otherwise). The DOM-clobbering risk that would normally justify keeping that protection can't reach the app's real `window`/`document` globals from inside an isolated shadow root.

Applied uniformly — every SVG gets the Sandbox, not only ones that happen to use `<style>` — for consistency, and so the id-isolation benefit applies everywhere rather than conditionally. One consequence: the normal Tailwind/`prose` CSS cascade doesn't cross the shadow boundary, so the Sandbox injects its own small, developer-authored `:host` stylesheet to reproduce the intended responsive sizing (`max-width: 100%; height: auto`) — unrelated to, and not governed by, the Markdown Sanitize Schema.

## Considered Options

- **Reject `<style>` outright, rely on SVG presentation attributes only** — simpler, no Shadow DOM build cost, but forecloses any future legitimate need for grouped/reused styling inside a diagram; superseded once Shadow DOM made real scoping cheap enough to build.
- **Schema-restrict `<style>`'s CSS *content* (parse and validate selectors)** — not pursued: `hast-util-sanitize` only polices tags/attributes, not a `<style>` element's text content, so this would require a separate CSS parser/validator with no existing precedent in this codebase.

## Consequences

- Shadow DOM support (`customElements`/`attachShadow`) is assumed; no polyfill/fallback is provided for browsers lacking it.
- Jest's `react-markdown` mock (`ui/test/__mocks__/react-markdown.tsx`) renders `children` into a plain `<div>`, ignoring `components`/`rehypePlugins` entirely — neither the Markdown Sanitize Schema's stripping behavior nor the SVG Sandbox's shadow-mounting can be exercised through `<Markdown>` in a Jest test. Schema correctness is unit-tested by calling the real `unified().use(rehypeRaw).use(rehypeSanitize, schema)` pipeline directly, bypassing the mock; shadow-DOM CSS isolation itself is a Playwright E2E concern.
