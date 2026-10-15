import type { DashboardWidget } from './types';

// Static sample data for this slice — no fetch, no file I/O (see design
// spec D6). This function is the seam a future slice swaps for a real
// load; nothing else in the dashboard depends on how this data is sourced.
const WIDGETS: DashboardWidget[] = [
  {
    id: 'welcome',
    type: 'markdown',
    title: 'Welcome',
    subtitle: 'Your AI Workspace',
    content:
      '# Welcome to Amazing Hashbrown\n\nThis is your central dashboard for all AI-powered features.',
  },
  {
    id: 'getting-started',
    type: 'markdown',
    title: 'Getting Started',
    subtitle: 'A few things to try',
    content:
      '## Getting Started\n\n- Start a chat from the sidebar\n- Browse the **Wiki** for ingested knowledge\n- Check **Workspaces** for active projects\n- Visit **Settings** to configure providers and tools',
  },
  {
    id: 'tip-of-the-day',
    type: 'markdown',
    title: 'Tip',
    content: 'You can fork any thread to explore a different direction without losing the original.',
  },
  {
    id: 'changelog',
    type: 'markdown',
    title: "What's New",
    subtitle: 'Recent changes',
    content:
      '### Dashboard\n\nThis dashboard is new! More widget types and the ability to customize your layout are coming in future updates.',
  },
];

export function useDashboardWidgets(): DashboardWidget[] {
  return WIDGETS;
}
