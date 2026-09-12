# Markdown External Links Open in a New Tab — Design

**Date:** 2026-09-12
**Status:** Approved

---

## 1. Problem & Goal

Chat bubbles (and other markdown surfaces) render links exactly as authored: a plain `<a href>` with no `target`. Clicking a link a user or an agent posted in chat navigates the current tab away from the conversation. The user then has to right-click/long-press to open the link in a new tab, or navigate back to the app and re-find their place — breaking focus mid-conversation.

Goal: every markdown-rendered link to an external, absolute `http(s)` URL opens in a new tab automatically, with no change to how relative/in-app links behave.

---

## 2. Scope

**In scope:**

- The shared `Markdown` component (`ui/src/components/markdown.tsx`) gains an `a` render override that adds `target="_blank"` and `rel="noopener noreferrer"` to any link whose `href` is an absolute `http://` or `https://` URL.
- Because `Markdown` is shared, this applies uniformly everywhere it's used: chat bubbles (user + assistant messages), thought blocks, and wiki page content/metadata.

**Out of scope:**

- Any change to how internal/relative links behave or navigate (e.g. wiki's `/wiki?view=document&...` links, which are built server-side as relative URLs — see §3). These are left exactly as they render today.
- SPA-style client-side routing/interception for internal links. Not part of this request; internal links today are plain anchors and remain plain anchors.
- `mailto:` and `tel:` links — untouched, no `target`/`rel` added.

---

## 3. Definition of "External"

A link is treated as external solely by inspecting its `href` string: it matches `/^https?:\/\//i`.

This is a syntactic check, not an origin comparison. Relative paths (`/wiki?...`), fragment links (`#section`), `mailto:`, and `tel:` all fail the match and are left alone. An absolute `http(s)` link back to the app's own origin (unlikely in practice, since internal links are generated as relative paths — see `api/src/routes/v1/wiki.route.ts`'s `links` substitution map) would still be treated as external and get `target="_blank"`. This tradeoff is accepted: the app never generates same-origin absolute links today, so the case doesn't arise in practice, and a purely syntactic check is simpler and has no async/DOM dependency.

---

## 4. Implementation

`ui/src/components/markdown.tsx` gains a small override component, following the existing pattern used for `img` (`MarkdownImg`) and `pre` (`CodeBlock`) in the same file:

```tsx
const EXTERNAL_HREF_RE = /^https?:\/\//i;

function MarkdownLink(props: Record<string, unknown>) {
  const href = String(props.href ?? '');
  const isExternal = EXTERNAL_HREF_RE.test(href);
  return (
    <a
      {...(props as preact.JSX.HTMLAttributes<HTMLAnchorElement>)}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
    />
  );
}
```

Registered in the `components` map passed to `ReactMarkdown`:

```tsx
components={{
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  img: (props) => <MarkdownImg {...(props as Record<string, unknown>)} />,
  a: (props) => <MarkdownLink {...(props as Record<string, unknown>)} />,
}}
```

**Security note:** `rel="noopener noreferrer"` is applied whenever `target="_blank"` is set. This prevents the opened page from reaching back into the originating tab via `window.opener` (reverse tabnabbing) and suppresses the `Referer` header sent to the external site.

No error handling is needed — this is synchronous rendering logic with no failure path.

---

## 5. Testing Plan

- Unit test in the `Markdown` component's test coverage: rendering `[text](https://example.com)` produces an `<a>` with `target="_blank"` and `rel="noopener noreferrer"`.
- Unit test: rendering a relative link (e.g. `[text](/wiki?view=document&domain=x&page=y.md)`) produces an `<a>` with neither `target` nor `rel` set.
- Unit test: rendering a `mailto:` link produces an `<a>` with neither `target` nor `rel` set.
- Check `ui/test/__mocks__/react-markdown.tsx` and `ui/test/__mocks__/markdown.tsx` — if either mock stubs out `components` rendering entirely, it needs updating so the new `a` override is actually exercised by consuming tests (e.g. `ui/test/chat-message.test.tsx`).

---

## 6. Files Changed (expected)

| File | Change |
| --- | --- |
| `ui/src/components/markdown.tsx` | Add `MarkdownLink` override; register `a` in the `components` map |
| `ui/src/components/markdown.md` | Document the new-tab-for-external-links behavior |
| Markdown component tests | New cases per Testing Plan above |
| `ui/test/__mocks__/react-markdown.tsx` / `ui/test/__mocks__/markdown.tsx` | Updated only if needed to exercise the new `a` override |

---

## 7. Out of Scope

- Internal/relative link navigation behavior (no SPA routing changes).
- `mailto:`/`tel:` link handling.
- Origin-based (as opposed to syntactic) external-link detection.
