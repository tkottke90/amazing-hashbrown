import { Home, Settings } from 'lucide-preact';

import { Layout } from '@/components/layout';
import { ThemeToggle } from '@/components/theme-toggle';

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
      <div className="p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Amazing Hashbrown</h1>
            <p className="text-muted-foreground">
              Local LLM agent harness — persona knowledge base and autonomous assistant.
            </p>
          </div>
          <ThemeToggle />
        </div>
      </div>
    </Layout>
  );
}
