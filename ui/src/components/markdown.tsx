import type { ComponentChildren } from 'preact';
import { useSignal } from '@preact/signals';
import { memo } from 'preact/compat';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { codeBlockWrap } from '@/hooks/use-chat-display-settings';
import { markdownSanitizeSchema } from '@/lib/markdown-sanitize-schema';
import { ArtifactImage } from './artifact-image';
import { SvgSandbox } from './svg-sandbox';

// ---- helpers ----

function getCodeLanguage(children: ComponentChildren): string | undefined {
  const className = (children as { props?: { className?: string } })?.props?.className ?? '';
  const match = (className as string).match(/language-(.*)/);
  return match ? match[1] : undefined;
}

// ---- code block ----

export function CodeBlock(props: preact.JSX.HTMLAttributes<HTMLPreElement>) {
  const copied = useSignal(false);
  const lang = getCodeLanguage(props.children);
  const ref = { current: null as HTMLPreElement | null };

  function handleCopy() {
    navigator.clipboard.writeText(ref.current?.innerText ?? '').catch(() => {});
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  }

  return (
    <div className="relative group" data-testid="code-block">
      <pre
        ref={(el) => {
          ref.current = el;
        }}
        {...props}
        className={cn(
          codeBlockWrap.value
            ? 'whitespace-pre-wrap break-words'
            : 'whitespace-pre overflow-x-auto',
          props.className,
        )}
      />
      <div className="absolute top-2 right-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {lang && <span className="text-xs text-muted-foreground capitalize">{lang}</span>}
        <button
          type="button"
          aria-label="Copy code"
          onClick={handleCopy}
          className="rounded p-1 hover:bg-muted text-muted-foreground"
        >
          {copied.value ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

// ---- img override: routes artifact URLs to ArtifactImage ----

const ARTIFACT_RE = /^\/api\/v1\/artifacts\/([^/?#]+)/;

function MarkdownImg(props: Record<string, unknown>) {
  const src = String(props.src ?? '');
  const alt = props.alt != null ? String(props.alt) : undefined;
  const url = new URL(src, 'http://x');
  const match = url.pathname.match(ARTIFACT_RE);
  if (match) {
    return <ArtifactImage id={match[1] ?? ''} alt={alt} nsfw={url.hash === '#nsfw'} />;
  }
  return <img src={src} alt={alt} loading="lazy" className="rounded-md" />;
}

// ---- link override: opens external http(s) links in a new tab ----

const EXTERNAL_HREF_RE = /^https?:\/\//i;

export function MarkdownLink(props: preact.JSX.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const isExternal = EXTERNAL_HREF_RE.test(String(props.href ?? ''));
  return (
    <a
      {...props}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
    />
  );
}

// ---- react-markdown component overrides (module-level: stable reference
// across renders, so memo(MarkdownImpl) below actually avoids re-parsing
// unchanged content instead of seeing a "new" components object every time).
// Typed structurally off ReactMarkdown's own prop type (rather than a named
// import) so `node` and the rest of each entry's param shape always match
// whatever this react-markdown version actually expects. ----

type MarkdownReactMarkdownComponents = NonNullable<
  Parameters<typeof ReactMarkdown>[0]
>['components'];

const markdownComponents: MarkdownReactMarkdownComponents = {
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  img: (props) => <MarkdownImg {...(props as Record<string, unknown>)} />,
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
  // SvgSandbox is a generic shadow-DOM portal wrapper — it knows nothing
  // about SVG specifically, so the real <svg> element (with its own
  // viewBox/width/height/etc. attributes, already-sanitized) is built here
  // and handed to it as children, same as react-markdown's node props on
  // any other element override.
  svg: ({ node: _node, children, ...props }) => (
    <SvgSandbox>
      <svg {...(props as Record<string, unknown>)}>{children}</svg>
    </SvgSandbox>
  ),
};

// ---- public ----

export interface MarkdownProps {
  children: string;
  className?: string;
}

function MarkdownImpl({ children, className }: MarkdownProps) {
  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Order matters: raw HTML must be expanded before it can be
        // sanitized (an unexpanded `raw` node falls through sanitize's
        // transform untouched), and highlighting must run last so its own
        // injected hljs-* token spans never pass through the sanitize pass
        // at all — no need to allowlist highlight.js's class-naming scheme
        // (ADR-0071, GLOSSARY.md "Markdown Sanitize Schema").
        rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], rehypeHighlight]}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// Long threads re-render their message list often (streaming, HITL, new
// turns) even after the composer-isolation fix above — without this, every
// one of those re-renders would re-run the full react-markdown + remark-gfm
// + rehype-highlight pipeline for every assistant message in the thread,
// even ones whose content hasn't changed. children/className are both
// primitives, so preact/compat's default shallow comparison is sufficient.
export const Markdown = memo(MarkdownImpl);
