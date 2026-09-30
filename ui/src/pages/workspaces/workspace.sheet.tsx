import { BabSheetContent, NavProps } from "@/components/layout";
import { buttonVariants, Button } from "@/components/ui/button";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import { useUrlHash } from "@/hooks/use-hash";
import { useNewThreadAction } from "@/hooks/use-thread";
import { Menu, Plus, MessagesSquare, FolderCode, ListTodo, LayoutDashboard } from "lucide-preact";

export function WorkspaceSheet({ navStart, navEnd, aside, addLabel, onAddClick }: NavProps) {
  const { createNewThread } = useNewThreadAction();
  const hash = useUrlHash();

  return (
    <Sheet>
      <nav
        aria-label="Bottom navigation"
        className="fixed flex-col
         inset-x-0 bottom-0 z-40 flex items-start justify-between border-t border-border bg-background px-4 pt-4 lg:hidden"
      >
        <div className="p-2 flex gap-2
        bg-card rounded w-full
        *:flex *:flex-1 *:flex-col *:px-2 *:py-1 *:rounded *:items-center *:data-active:bg-background *:data-active:text-primary *:text-sm
        ">
          <a data-active={hash.value === 'overview'} href="#overview" ><LayoutDashboard className="size-[1em]" />&nbsp;Overview</a>
          <a data-active={hash.value === 'tasks'} href="#tasks" ><ListTodo className="size-[1em]" />&nbsp;Tasks</a>
          <a data-active={hash.value === 'files'} href="#files" ><FolderCode className="size-[1em]" />&nbsp;Files</a>
          <a data-active={hash.value === 'chat'} href="#chat" ><MessagesSquare className="size-[1em]" />&nbsp;Chat</a>
        </div>
        <div className="flex justify-evenly w-full py-2">
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
            onClick={onAddClick ?? createNewThread}
            className=" w-fit px-4 rounded-4xl shadow-lg"
          >
            <Plus />
            {addLabel}
          </Button>

          <div className="flex flex-1 items-center justify-end gap-1">{navEnd}</div>
        </div>
      </nav>

      <BabSheetContent>{aside}</BabSheetContent>
    </Sheet>
  );
}
