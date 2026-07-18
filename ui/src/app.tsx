import { useEffect } from 'preact/hooks';
import { Settings } from 'lucide-preact';

import { Layout } from '@/components/layout';
import { ThemeToggle } from '@/components/theme-toggle';
import { ThreadSidebar } from '@/components/thread-sidebar';
import { ThreadView } from '@/pages/thread-view';
import { activeThreadId, switchThread, newThread, refreshThreadList } from '@/hooks/use-thread';

function AppNavEnd() {
  return (
    <div className="flex items-center gap-1">
      <a
        href="#"
        aria-label="Settings"
        className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <Settings className="size-4" />
      </a>
      <ThemeToggle />
    </div>
  );
}

export function App() {
  useEffect(() => {
    refreshThreadList();
    switchThread(activeThreadId.value);
    // Runs once on mount — hydrates whatever thread was active in the
    // previous session (or a fresh one) and populates the sidebar list.
  }, []);

  return (
    <Layout
      aside={<ThreadSidebar />}
      navEnd={<AppNavEnd />}
      onAddClick={() => newThread()}
      addLabel="New conversation"
    >
      <ThreadView />
    </Layout>
  );
}
