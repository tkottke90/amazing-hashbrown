import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/roles-api', () => ({
  fetchRoles: jest.fn(),
  createRole: jest.fn(),
  patchRole: jest.fn(),
  deleteRole: jest.fn(),
  setDefaultRole: jest.fn(),
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));
jest.mock('@/hooks/use-providers', () => ({
  providers: { value: [] },
  fetchProviders: jest.fn(),
}));

import { SubAgentRolesCard } from '@/pages/settings/sub-agent-roles-card';
import * as api from '@/services/roles-api';

const mockFetch = api.fetchRoles as jest.MockedFunction<typeof api.fetchRoles>;
const mockDelete = api.deleteRole as jest.MockedFunction<typeof api.deleteRole>;
const mockSetDefault = api.setDefaultRole as jest.MockedFunction<typeof api.setDefaultRole>;

const RESEARCHER = { name: 'researcher', provider: 'ollama', model: 'llama3' };
const DEFAULT = { name: 'default' };

describe('SubAgentRolesCard', () => {
  const originalConfirm = global.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({ roles: [RESEARCHER, DEFAULT], defaultRole: 'default' });
    global.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    global.confirm = originalConfirm;
  });

  it('renders a row for each configured role with a Default badge on the current default', async () => {
    const { container } = render(<SubAgentRolesCard />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByText('researcher')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="role-row-default"] [data-slot="role-row-default-badge"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector(
        '[data-slot="role-row-researcher"] [data-slot="role-row-default-badge"]',
      ),
    ).not.toBeInTheDocument();
  });

  it('"Make default" calls setDefaultRole and refreshes', async () => {
    mockSetDefault.mockResolvedValue({ defaultRole: 'researcher' });
    render(<SubAgentRolesCard />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));

    await waitFor(() => expect(mockSetDefault).toHaveBeenCalledWith('researcher'));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('Remove asks for confirmation before deleting', async () => {
    mockDelete.mockResolvedValue({ deleted: true });
    render(<SubAgentRolesCard />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeButtons[0]!);

    expect(global.confirm).toHaveBeenCalled();
    await waitFor(() => expect(mockDelete).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('Remove does not delete when confirmation is declined', async () => {
    global.confirm = jest.fn(() => false);
    render(<SubAgentRolesCard />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeButtons[0]!);

    expect(mockDelete).not.toHaveBeenCalled();
  });

  // The Add/Edit save flow (createRole/patchRole call shape) is covered by
  // RoleDrawer's own isolated test file instead — the drawer's internal
  // submit button and this card's "Add role" trigger share a label (dialog
  // children stay mounted at all times, same as McpServerDrawer/
  // McpServersPanel), so RoleDrawer gets its own distinctly-labeled trigger
  // there rather than fighting that ambiguity here.
});
