import { Home, Settings } from 'lucide-preact';

import { Layout } from '@/components/layout';
import { ThemeToggle } from '@/components/theme-toggle';
import { ThreadView } from '@/pages/thread-view';

function AppAside() {
  return (
    <nav className="flex flex-col gap-1 p-4">
      <a
        href="#"
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-sidebar-accent"
      >
        <Home className="size-4" />
        Home
      </a>
      <a
        href="#"
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-sidebar-accent"
      >
        <Settings className="size-4" />
        Settings
      </a>
    </nav>
  );
}

export function App() {
  return (
    <Layout aside={<AppAside />} navEnd={<ThemeToggle />}>
      <ThreadView />
    </Layout>
  );
}
