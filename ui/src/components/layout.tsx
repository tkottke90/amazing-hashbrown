import { Menu, Plus } from 'lucide-preact';
import type { ComponentChildren, ComponentType } from 'preact';

import { Button, buttonVariants } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ThemeToggle } from './theme-toggle';
import { ThreadSidebar } from './thread-sidebar';
import { useNewThreadAction } from '@/hooks/use-thread';
import { cn } from '@/lib/utils';
import { BaseProps } from '@/lib/tsx.utils';

function AppNavEnd() {
  return (
    <div className="flex items-center gap-1">
      <ThemeToggle />
    </div>
  );
}

export interface NavProps {
  aside?: ComponentChildren;
  navStart?: ComponentChildren;
  navEnd?: ComponentChildren;
  onAddClick?: () => void;
  addLabel?: string;
  // Hides just the floating add button, keeping the rest of the bottom bar
  // (hamburger menu, navStart, navEnd) — for a tab with no add action.
  hideAddButton?: boolean;
}

interface LayoutProps extends NavProps {
  children: ComponentChildren;

  /**
   * Hide the bottom app bar
   */
  hideBottomBar?: boolean;

  /**
   * Provide a custom Bottom App Bar which will be used in place
   * of the default one
   */
  MobileAside?: ComponentType<NavProps>;
}

export function Layout({ children, MobileAside, hideBottomBar, ...sharedProps }: LayoutProps) {
  return (
    <div className="flex size-full flex-col overflow-hidden lg:flex-row">
      <aside
        aria-label="Sidebar navigation"
        className="hidden w-64 shrink-0 overflow-y-auto border-r border-border bg-sidebar text-sidebar-foreground lg:block"
      >
        {sharedProps.aside ?? <ThreadSidebar />}
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden lg:z-10 lg:rounded-l-2xl lg:shadow-[-8px_0_24px_-6px_rgb(0_0_0_/_0.15)]">
        <div className={cn('min-h-0 flex-1 overflow-hidden lg:pb-0', !hideBottomBar && 'pb-bab')}>
          {children}
        </div>
      </main>

      {!hideBottomBar &&
        (MobileAside ? <MobileAside {...sharedProps} /> : <DefaultSheet {...sharedProps} />)}
    </div>
  );
}

function DefaultSheet({
  navStart,
  navEnd,
  aside,
  addLabel = 'Add',
  onAddClick,
  hideAddButton,
}: NavProps) {
  const { createNewThread } = useNewThreadAction();

  return (
    <Sheet>
      <nav
        aria-label="Bottom navigation"
        className="fixed inset-x-0 bottom-0 z-40 flex h-20 items-start justify-between border-t border-border bg-background px-4 pt-4 lg:hidden"
      >
        <div className="flex flex-1 items-center gap-1">
          <SheetTrigger
            aria-label="Open navigation menu"
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
          >
            <Menu />
          </SheetTrigger>
          {navStart}
        </div>

        {!hideAddButton && (
          <Button
            size="icon"
            aria-label={addLabel}
            onClick={onAddClick ?? createNewThread}
            className="absolute left-1/2 -top-5 size-12 -translate-x-1/2 rounded-full shadow-lg"
          >
            <Plus />
          </Button>
        )}

        <div className="flex flex-1 items-center justify-end gap-1">{navEnd ?? <AppNavEnd />}</div>
      </nav>

      <BabSheetContent>{aside}</BabSheetContent>
    </Sheet>
  );
}

export function BabSheetContent({ children }: BaseProps) {
  return (
    <SheetContent side="bottom" className="data-[side=bottom]:h-[90vh] lg:hidden">
      <SheetHeader>
        <SheetTitle>Menu</SheetTitle>
      </SheetHeader>
      <div className="overflow-y-auto px-4 h-full pb-4">{children ?? <ThreadSidebar />}</div>
    </SheetContent>
  );
}
