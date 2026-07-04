import type { ComponentChildren } from 'preact';
import { Menu, Plus } from 'lucide-preact';

import { Button, buttonVariants } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

export interface LayoutProps {
  aside: ComponentChildren;
  children: ComponentChildren;
  navStart?: ComponentChildren;
  navEnd?: ComponentChildren;
  onAddClick?: () => void;
  addLabel?: string;
}

export function Layout({
  aside,
  children,
  navStart,
  navEnd,
  onAddClick,
  addLabel = 'Add',
}: LayoutProps) {
  return (
    <div className="flex size-full flex-col overflow-hidden lg:flex-row">
      <aside
        aria-label="Sidebar navigation"
        className="hidden w-64 shrink-0 overflow-y-auto border-r border-border bg-sidebar text-sidebar-foreground lg:block"
      >
        {aside}
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden lg:z-10 lg:rounded-l-2xl lg:shadow-[-8px_0_24px_-6px_rgb(0_0_0_/_0.15)]">
        <div className="min-h-0 flex-1 overflow-y-auto pb-20 lg:pb-0">{children}</div>
      </main>

      <Sheet>
        <nav
          aria-label="Bottom navigation"
          className="fixed inset-x-0 bottom-0 z-40 flex h-20 items-center justify-between border-t border-border bg-background px-4 lg:hidden"
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

          <Button
            size="icon"
            aria-label={addLabel}
            onClick={onAddClick}
            className="absolute left-1/2 -top-5 size-12 -translate-x-1/2 rounded-full shadow-lg"
          >
            <Plus />
          </Button>

          <div className="flex flex-1 items-center justify-end gap-1">{navEnd}</div>
        </nav>

        <SheetContent side="bottom" className="data-[side=bottom]:h-[90vh] lg:hidden">
          <SheetHeader>
            <SheetTitle>Menu</SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto px-4 pb-4">{aside}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
