import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

import { cn } from '@/lib/utils';

interface ChatMessageScrollWrapperProps {
  children: ComponentChildren;
  className?: string;
}

export function ChatMessageScrollWrapper({ children, className }: ChatMessageScrollWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Assume user is near bottom on load — flipped by IntersectionObserver when they scroll up
  const isNearBottomRef = useRef(true);
  // Suppresses smooth-scroll during initial layout before the mount scroll settles
  const isInitializedRef = useRef(false);

  // Instant scroll to bottom on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;

    // Wait two animation frames so the initial ResizeObserver burst from layout
    // doesn't trigger a smooth scroll on top of the instant one
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => {
        isInitializedRef.current = true;
      });
      // Return value of inner rAF callback isn't used for cleanup here;
      // outer cancel below covers the case where the component unmounts before id2 fires
      return id2;
    });

    return () => cancelAnimationFrame(id1);
  }, []);

  // Track whether the bottom sentinel is visible within the scroll container.
  // Visible → user is at (or near) the bottom and expecting new content.
  // Hidden → user has scrolled up to read older messages; don't interrupt them.
  useEffect(() => {
    const container = containerRef.current;
    const sentinel = sentinelRef.current;
    if (!container || !sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        isNearBottomRef.current = entry.isIntersecting;
      },
      { root: container, threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Smooth-scroll to bottom whenever content grows, but only when the user is
  // already near the bottom (sentinel is visible).
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const observer = new ResizeObserver(() => {
      if (!isInitializedRef.current) return;
      if (isNearBottomRef.current) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      }
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className={cn('overflow-y-auto', className)}>
      <div ref={contentRef}>{children}</div>
      {/* Sentinel sits outside contentRef so its position is unaffected by content
          padding/margin, giving a clean bottom-of-viewport signal */}
      <div ref={sentinelRef} aria-hidden="true" />
    </div>
  );
}
