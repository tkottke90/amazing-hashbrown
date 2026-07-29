import { useEffect } from 'preact/hooks';
import { LocationProvider, Router, useLocation } from 'preact-iso';
import { BookOpen, Settings } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { Layout } from '@/components/layout';
import { ThemeToggle } from '@/components/theme-toggle';
import { ThreadSidebar } from '@/components/thread-sidebar';
import { ThreadView } from '@/pages/thread-view';
import { WikiView } from '@/pages/wiki-view';
import { activeThreadId, switchThread, newThread, refreshThreadList } from '@/hooks/use-thread';

function WikiNavLink() {
  const { url } = useLocation();
  const isActive = url === '/wiki';
  return (
    <a
      href="/wiki"
      aria-label="Wiki"
      className={cn(
        'rounded-md p-2 transition-colors',
        isActive
          ? 'bg-sidebar-accent text-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
      )}
    >
      <BookOpen className="size-4" />
    </a>
  );
}

function AppNavEnd() {
  return (
    <div className="flex items-center gap-1">
      <WikiNavLink />
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

// path prop is consumed by preact-iso's Router for route matching
function WikiRoot(_props: { path?: string }) {
  return (
    <Layout aside={<ThreadSidebar />} navEnd={<AppNavEnd />}>
      <WikiView />
    </Layout>
  );
}

function ChatRoot(_props: { path?: string }) {
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

export function App() {
  return (
    <LocationProvider>
      <Router>
        <ChatRoot path="/" />
        <WikiRoot path="/wiki" />
      </Router>
    </LocationProvider>
  );
}
