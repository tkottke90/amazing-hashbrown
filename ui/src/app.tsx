import { LocationProvider, Router } from 'preact-iso';
import { useEffect } from 'preact/hooks';

import { ToastContainer } from '@/components/toast-container';
import { MovePrompts } from '@/components/task-board/move-prompts';
import { TooltipProvider } from '@/components/ui/tooltip';
import { activeGuard } from '@/hooks/use-settings-guard';
import { connectLiveEvents } from '@/hooks/use-live-events';
import { fetchChatDisplaySettings } from '@/hooks/use-chat-display-settings';
import { ChatRoot } from '@/pages/chat';
import { DashboardView } from '@/pages/dashboard';
import { SettingsView } from '@/pages/settings';
import { ThreadsView } from '@/pages/threads';
import { WikiView } from '@/pages/wiki';
import { WorkspacesView } from '@/pages/workspaces';
import { WorkspaceDetailView } from '@/pages/workspaces/[id]';
import { CloseProjectView } from '@/pages/workspaces/close/[id]';
import { InboxView } from '@/pages/inbox';

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

  // Fetched once per tab session so CodeBlock (markdown.tsx) can read the
  // user's scroll/wrap preference without every page that renders Markdown
  // needing to fetch it itself.
  useEffect(() => {
    void fetchChatDisplaySettings();
  }, []);

  return (
    <LocationProvider>
      <TooltipProvider>
        <ToastContainer />
        <MovePrompts />
        <Router>
          <DashboardView path="/" />
          <ChatRoot path="/chat/:id" />
          <WikiView path="/wiki" />
          <SettingsView path="/settings" />
          <ThreadsView path="/threads" />
          <WorkspacesView path="/workspaces" />
          <WorkspaceDetailView path="/workspaces/:id" />
          <CloseProjectView path="/workspaces/:id/close" />
          <InboxView path="/inbox" />
        </Router>
      </TooltipProvider>
    </LocationProvider>
  );
}
