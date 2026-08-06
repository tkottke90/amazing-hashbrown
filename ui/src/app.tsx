import { useEffect } from 'preact/hooks';
import { LocationProvider, Router, useLocation } from 'preact-iso';
import { BookOpen, Settings } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { Layout } from '@/components/layout';
import { ThemeToggle } from '@/components/theme-toggle';
import { ThreadSidebar } from '@/components/thread-sidebar';
import { ToastContainer } from '@/components/toast-container';
import { ThreadView } from '@/pages/thread-view';
import { WikiView } from '@/pages/wiki-view';
import { SettingsView } from '@/pages/settings-view';
import { activeThreadId, switchThread, newThread, refreshThreadList } from '@/hooks/use-thread';

function WikiNavLink() {
  const { url } = useLocation();
  const isActive = url === '/wiki' || url.startsWith('/wiki?');
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

function SettingsNavLink() {
  const { url } = useLocation();
  const isActive = url === '/settings' || url.startsWith('/settings?');
  return (
    <a
      href="/settings"
      aria-label="Settings"
      className={cn(
        'rounded-md p-2 transition-colors',
        isActive
          ? 'bg-sidebar-accent text-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
      )}
    >
      <Settings className="size-4" />
    </a>
  );
}

function AppNavEnd() {
  return (
    <div className="flex items-center gap-1">
      <WikiNavLink />
      <SettingsNavLink />
      <ThemeToggle />
    </div>
  );
}

// path prop is consumed by preact-iso's Router for route matching
function RootRedirect(_props: { path?: string }) {
  const { route } = useLocation();
  useEffect(() => {
    route(`/chat/${activeThreadId.value}`);
  }, []);
  return null;
}

function WikiRoot(_props: { path?: string }) {
  return (
    <Layout aside={<ThreadSidebar />} navEnd={<AppNavEnd />}>
      <WikiView />
    </Layout>
  );
}

function SettingsRoot(_props: { path?: string }) {
  return (
    <Layout aside={<ThreadSidebar />} navEnd={<AppNavEnd />}>
      <SettingsView />
    </Layout>
  );
}

function ChatRoot({ id }: { path?: string; id?: string }) {
  const { route } = useLocation();

  useEffect(() => {
    refreshThreadList();
  }, []);

  useEffect(() => {
    if (id) void switchThread(id);
  }, [id]);

  return (
    <Layout
      aside={<ThreadSidebar />}
      navEnd={<AppNavEnd />}
      onAddClick={() => {
        const newId = newThread();
        route(`/chat/${newId}`);
      }}
      addLabel="New conversation"
    >
      <ThreadView />
    </Layout>
  );
}

export function App() {
  return (
    <LocationProvider>
      <ToastContainer />
      <Router>
        <RootRedirect path="/" />
        <ChatRoot path="/chat/:id" />
        <WikiRoot path="/wiki" />
        <SettingsRoot path="/settings" />
      </Router>
    </LocationProvider>
  );
}
