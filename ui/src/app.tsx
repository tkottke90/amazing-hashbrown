import { LocationProvider, Router, useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';

import { ToastContainer } from '@/components/toast-container';
import { activeThreadId } from '@/hooks/use-thread';
import { SettingsView } from '@/pages/settings-view';
import { ChatRoot } from '@/pages/thread-view';
import { WikiView } from '@/pages/wiki-view';

// path prop is consumed by preact-iso's Router for route matching
function RootRedirect(_props: { path?: string }) {
  const { route } = useLocation();
  useEffect(() => {
    route(`/chat/${activeThreadId.value}`);
  }, []);
  return null;
}

export function App() {
  return (
    <LocationProvider>
      <ToastContainer />
      <Router>
        <RootRedirect path="/" />
        <ChatRoot path="/chat/:id" />
        <WikiView path="/wiki" />
        <SettingsView path="/settings" />
      </Router>
    </LocationProvider>
  );
}
