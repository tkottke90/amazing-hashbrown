import { render, screen, fireEvent } from '@testing-library/preact';

jest.mock('@/hooks/use-workspaces', () => ({
  patchWorkspace: jest.fn(),
}));

import { WorkspaceSettingsDrawer } from '@/pages/workspaces/workspace-settings-drawer';
import type { Workspace } from '@/services/workspaces-api';

const WORKSPACE: Workspace = {
  id: 'ws-1',
  name: 'My Workspace',
  description: null,
  goal: null,
  location: '/workspaces/my-workspace',
  managedLocation: true,
  remoteUrl: null,
  javascript: false,
  python: false,
  git: false,
  wikiId: null,
  systemPrompt: null,
  threadId: null,
  summaryPath: null,
  lastSummarizedMessageId: null,
  autoApproveShell: false,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
  lastChange: '2026-08-29T00:00:00.000Z',
};

// Issue #397: iOS Safari zooms the page when a focused native control
// renders under 16px. These textareas previously hardcoded text-sm;
// confirm each now renders at the mobile-safe text-base (16px) size, with
// their fixed height preserved (field-sizing-fixed overrides the shared
// Textarea's default auto-grow behavior).
describe('WorkspaceSettingsDrawer — mobile-safe font sizes (issue #397)', () => {
  function expectMobileSafe(el: Element) {
    expect(el).toHaveClass('text-base', 'md:text-sm');
    expect(el.className).not.toMatch(/\btext-xs\b/);
  }

  it('renders the Description and Goal textareas at a mobile-safe size', () => {
    render(<WorkspaceSettingsDrawer workspace={WORKSPACE} />);
    fireEvent.click(screen.getByText('Edit'));

    const description = screen.getByPlaceholderText('Describe this workspace');
    expectMobileSafe(description);
    expect(description).toHaveClass('field-sizing-fixed', 'h-20', 'resize-none');

    const goal = screen.getByPlaceholderText('What should be accomplished in this workspace?');
    expectMobileSafe(goal);
    expect(goal).toHaveClass('field-sizing-fixed', 'h-20', 'resize-none');
  });
});
