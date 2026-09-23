import { LocationProvider, Router, useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';

import { ToastContainer } from '@/components/toast-container';
import { TooltipProvider } from '@/components/ui/tooltip';
import { activeThreadId } from '@/hooks/use-thread';
import { activeGuard } from '@/hooks/use-settings-guard';
import { connectLiveEvents } from '@/hooks/use-live-events';
import { ChatRoot } from '@/pages/chat';
import { SettingsView } from '@/pages/settings';
import { WikiView } from '@/pages/wiki';
import { WorkspacesView } from '@/pages/workspaces';
import { WorkspaceDetailView } from '@/pages/workspaces/[id]';
import { CloseProjectView } from '@/pages/workspaces/close/[id]';
import { InboxView } from '@/pages/inbox';

// path prop is consumed by preact-iso's Router for route matching
function RootRedirect(_props: { path?: string }) {
  const { route } = useLocation();
  useEffect(() => {
    route(`/chat/${activeThreadId.value}`);
  }, []);
  return null;
}

export function App() {
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (activeGuard.value?.isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // Standing app-level SSE connection — opened once for the tab's whole
  // lifetime, independent of whatever page/workspace is active. See
  // use-live-events.ts and docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md.
  useEffect(() => {
    const es = connectLiveEvents();
    return () => es.close();
  }, []);

  return (
    <LocationProvider>
      <TooltipProvider>
        <ToastContainer />
        <Router>
          <RootRedirect path="/" />
          <ChatRoot path="/chat/:id" />
          <WikiView path="/wiki" />
          <SettingsView path="/settings" />
          <WorkspacesView path="/workspaces" />
          <WorkspaceDetailView path="/workspaces/:id" />
          <CloseProjectView path="/workspaces/:id/close" />
          <InboxView path="/inbox" />
        </Router>
      </TooltipProvider>
    </LocationProvider>
  );
}
