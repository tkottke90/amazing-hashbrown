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

function getCodeText(children: ComponentChildren): string {
  return (children as { props?: { children?: string } })?.props?.children ?? '';
}

// ---- image block ----

interface ImageBlockProps {
  id: string;
  alt?: string;
  nsfw?: boolean;
}

function parseImageBlock(raw: string): ImageBlockProps {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      result[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return {
    id: result.id ?? '',
    alt: result.alt,
    nsfw: result.nsfw === 'true',
  };
}

// ---- code block ----

function CodeBlock(props: preact.JSX.HTMLAttributes<HTMLPreElement>) {
  const copied = useSignal(false);
  const lang = getCodeLanguage(props.children);

  // Delegate image blocks to ArtifactImage
  if (lang === 'image') {
    const parsed = parseImageBlock(getCodeText(props.children));
    return <ArtifactImage {...parsed} />;
  }

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
        components={{ pre: ({ node: _node, ...props }) => <CodeBlock {...props} /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
