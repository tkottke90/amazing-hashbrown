import type { ComponentChildren } from 'preact';
import { useSignal } from '@preact/signals';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { ArtifactImage } from './artifact-image';

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
    <div className="relative group">
      <pre
        ref={(el) => {
          ref.current = el;
        }}
        {...props}
        className={cn(props.className, 'overflow-hidden whitespace-pre-line')}
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

// ---- public ----

export interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
          img: (props) => <MarkdownImg {...(props as Record<string, unknown>)} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
